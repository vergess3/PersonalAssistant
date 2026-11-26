"""HTTPS worker: Windows physical-interface DNS/TLS, JSON frames on anonymous pipes.
No proxy, redirects, disk credentials, or request-body logs. Concurrent long-polls
and file transfers cannot block each other. A write is never retried here.
"""
import base64, concurrent.futures, http.client, ipaddress, json, secrets, socket, ssl, struct, sys, threading, time
from urllib.parse import urlsplit

MAX_BYTES = 101 * 1024 * 1024
output_lock = threading.Lock()
socket_lock = threading.Lock()
active = {}
cancelled = set()
cache = {}
context = ssl.create_default_context()

def emit(value):
    with output_lock:
        sys.stdout.buffer.write(json.dumps(value, ensure_ascii=True).encode('ascii') + b'\n')
        sys.stdout.buffer.flush()

def register(request_id, sock):
    with socket_lock:
        if request_id in cancelled:
            sock.close()
            raise RuntimeError('cancelled')
        active[request_id] = sock

def physical_socket(family, kind, net, request_id, timeout):
    sock = socket.socket(family, kind)
    sock.settimeout(timeout)
    sock.setsockopt(socket.IPPROTO_IP, 31, struct.pack('!I', net['interfaceIndex']))
    sock.bind((net['localAddress'], 0))
    register(request_id, sock)
    return sock

def resolve(host, net, request_id):
    key = (host, net['interfaceIndex'], net['localAddress'])
    saved = cache.get(key)
    if saved and saved[0] > time.monotonic():
        return saved[1]
    transaction = secrets.randbelow(65536)
    question = b''.join(bytes([len(p)]) + p.encode('ascii') for p in host.split('.')) + b'\0'
    packet = struct.pack('!HHHHHH', transaction, 0x100, 1, 0, 0, 0) + question + struct.pack('!HH', 1, 1)
    for server in net['dnsServers']:
        try:
            with physical_socket(socket.AF_INET, socket.SOCK_DGRAM, net, request_id, 5) as udp:
                udp.connect((server, 53)); udp.send(packet); data = udp.recv(65535)
            tx, flags, questions, answers, _, _ = struct.unpack('!HHHHHH', data[:12])
            if tx != transaction or flags & 0x20F or not flags & 0x8000:
                continue
            def skip(offset):
                for _ in range(128):
                    size = data[offset]
                    if size == 0: return offset + 1
                    if size & 0xC0 == 0xC0: return offset + 2
                    if size > 63: raise ValueError('dns_name')
                    offset += size + 1
                raise ValueError('dns_name')
            offset = 12
            for _ in range(questions): offset = skip(offset) + 4
            ips, ttls = [], []
            for _ in range(answers):
                offset = skip(offset)
                typ, cls, ttl, size = struct.unpack('!HHIH', data[offset:offset+10]); offset += 10
                if typ == 1 and cls == 1 and size == 4:
                    ip = socket.inet_ntoa(data[offset:offset+size])
                    if ipaddress.ip_address(ip).is_global: ips.append(ip); ttls.append(ttl)
                offset += size
            if ips:
                cache[key] = (time.monotonic() + min(300, max(1, min(ttls))), ips)
                return ips
        except (OSError, ValueError, IndexError, struct.error):
            continue
    raise RuntimeError('dns_failed')

def run(req):
    request_id = req['id']; stage = 'validate'; wrote = False; tls = None
    try:
        net = req['network']; url = urlsplit(req['url']); host = url.hostname or ''
        allowed = host == 'slack.com' or host.endswith('.slack.com') or host.endswith('.qq.com')
        if not allowed or url.scheme != 'https' or url.port or url.username or url.password or url.fragment:
            raise ValueError('destination')
        if req['method'] not in ('GET', 'POST', 'DELETE', 'HEAD'):
            raise ValueError('method')
        body = base64.b64decode(req.get('body', ''), validate=True)
        if len(body) > MAX_BYTES: raise ValueError('body_too_large')
        headers = req.get('headers', {})
        for key, value in headers.items():
            if not isinstance(value, str) or any(c in key + value for c in '\r\n'):
                raise ValueError('header')
        stage = 'dns'; ips = resolve(host, net, request_id)
        stage = 'connect'
        # Retrying another IP is safe only before HTTP request bytes are sent.
        for ip in ips[:3]:
            sock = None
            try:
                sock = physical_socket(socket.AF_INET, socket.SOCK_STREAM, net, request_id, 10)
                sock.connect((ip, 443))
                tls = context.wrap_socket(sock, server_hostname=host)
                register(request_id, tls); break
            except OSError:
                if sock: sock.close()
        if tls is None: raise RuntimeError('connect_failed')
        tls.settimeout(120)
        headers = {k: v for k, v in headers.items() if k.lower() not in ('host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding')}
        headers.update({'Host': host, 'Connection': 'close', 'Content-Length': str(len(body)), 'Accept-Encoding': 'identity'})
        target = url.path or '/'
        if url.query: target += '?' + url.query
        head = f"{req['method']} {target} HTTP/1.1\r\n" + ''.join(f'{k}: {v}\r\n' for k, v in headers.items()) + '\r\n'
        head = head.encode('ascii')
        stage = 'request'; wrote = True
        tls.sendall(head); tls.sendall(body)
        stage = 'response'
        response = http.client.HTTPResponse(tls); response.begin()
        length = response.getheader('Content-Length')
        if length and int(length) > MAX_BYTES: raise ValueError('response_too_large')
        data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES: raise ValueError('response_too_large')
        emit({'id': request_id, 'status': response.status, 'headers': response.getheaders(),
              'body': base64.b64encode(data).decode('ascii')})
    except Exception as exc:
        # No remote text, URL, query, header or payload in errors.
        emit({'id': request_id, 'error': 'direct_request_failed', 'stage': stage,
              'safeBeforeSend': not wrote, 'causeCode': type(exc).__name__})
    finally:
        if tls: tls.close()
        with socket_lock:
            sock = active.pop(request_id, None)
            if sock:
                try: sock.close()
                except OSError: pass
            cancelled.discard(request_id)

def main():
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for line in sys.stdin.buffer:
            try:
                req = json.loads(line.decode('utf-8'))
                if 'cancel' in req:
                    with socket_lock:
                        cancelled.add(req['cancel']); sock = active.get(req['cancel'])
                        if sock:
                            try: sock.shutdown(socket.SHUT_RDWR)
                            except OSError: pass
                            sock.close()
                else: pool.submit(run, req)
            except Exception:
                emit({'error': 'invalid_local_request'})

if __name__ == '__main__': main()
