"""Public, unauthenticated probes bound to the physical Windows interface.
No proxy settings or OS routes are modified. TLS verification stays enabled.
"""
import argparse
import http.client
import json
import socket
import ssl
import struct
import time
import secrets
import sys
from urllib.parse import urlsplit
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--interface', type=int, required=True)
parser.add_argument('--address', required=True)
parser.add_argument('--dns-server', required=True)
parser.add_argument('--request-stdin', action='store_true')
args = parser.parse_args()
rows = []

def dns_query(host):
    transaction = secrets.randbelow(65536)
    question = b''.join(bytes([len(p)]) + p.encode('ascii') for p in host.split('.')) + b'\0'
    packet = struct.pack('!HHHHHH', transaction, 0x100, 1, 0, 0, 0) + question + struct.pack('!HH', 1, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.settimeout(8)
        udp.setsockopt(socket.IPPROTO_IP, 31, struct.pack('!I', args.interface))
        udp.bind((args.address, 0))
        udp.connect((args.dns_server, 53))
        udp.send(packet)
        data = udp.recv(65535)
    tx, flags, questions, answers, _, _ = struct.unpack('!HHHHHH', data[:12])
    if tx != transaction or flags & 0x20F or not flags & 0x8000:
        raise RuntimeError('dns_response_invalid_or_truncated')
    def skip_name(offset):
        for _ in range(128):
            size = data[offset]
            if size == 0:
                return offset + 1
            if size & 0xC0 == 0xC0:
                return offset + 2
            offset += size + 1
        raise RuntimeError('dns_name_invalid')
    offset = 12
    for _ in range(questions):
        offset = skip_name(offset) + 4
    ips = []
    for _ in range(answers):
        offset = skip_name(offset)
        typ, cls, ttl, size = struct.unpack('!HHIH', data[offset:offset+10])
        offset += 10
        if typ == 1 and cls == 1 and size == 4:
            ips.append(socket.inet_ntoa(data[offset:offset+size]))
        offset += size
    return ips

def request(ip, host, path, method='GET', body=None, accept='application/json', extra_headers=None):
    started = time.monotonic()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(12)
    # Windows IP_UNICAST_IF (31) takes the interface index in network byte order.
    sock.setsockopt(socket.IPPROTO_IP, 31, struct.pack('!I', args.interface))
    sock.bind((args.address, 0))
    try:
        sock.connect((ip, 443))
        with ssl.create_default_context().wrap_socket(sock, server_hostname=host) as tls:
            body_bytes = body.encode() if body else b''
            extra_headers = extra_headers or {}
            permitted = {'authorization', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version'}
            for key, value in extra_headers.items():
                if key.lower() not in permitted or '\r' in str(value) or '\n' in str(value):
                    raise RuntimeError('invalid_request_header')
            headers_map = {'Host': host, 'Connection': 'close', 'Accept': accept,
                           'Content-Type': 'application/json', **extra_headers,
                           'Content-Length': str(len(body_bytes))}
            headers = f'{method} {path} HTTP/1.1\r\n' + ''.join(f'{k}: {v}\r\n' for k, v in headers_map.items()) + '\r\n'
            tls.sendall(headers.encode() + body_bytes)
            response = http.client.HTTPResponse(tls)
            response.begin()
            data = response.read(100000)
            meta = {'host': host, 'ip': ip, 'status': response.status,
                    'interface': args.interface, 'localAddress': tls.getsockname()[0],
                    'tlsVerified': True, 'elapsedMs': round((time.monotonic() - started) * 1000),
                    'responseHeaders': {k.lower(): v for k, v in response.getheaders()
                                        if k.lower() in {'content-type', 'x-oauth-scopes', 'mcp-session-id'}}}
            return meta, data
    finally:
        sock.close()

if args.request_stdin:
    # Called only by the Node diagnostic over anonymous pipes. No credentials
    # in argv or files; response data is returned to the parent's encrypted sink.
    try:
        payload = json.loads(sys.stdin.buffer.read().decode('utf-8'))
        url = urlsplit(payload['url'])
        permitted_paths = {'slack.com': {'/api/auth.test', '/api/conversations.replies'}, 'mcp.slack.com': {'/mcp'}}
        if url.scheme != 'https' or url.port or url.username or url.password or url.fragment or url.path not in permitted_paths.get(url.hostname, set()):
            raise RuntimeError('destination_not_allowed')
        method = payload.get('method', 'GET')
        if method not in {'GET', 'POST'}:
            raise RuntimeError('method_not_allowed')
        ips = dns_query(url.hostname)
        if not ips:
            raise RuntimeError('no_dns_A_answers')
        meta, data = request(ips[0], url.hostname, url.path + ('?' + url.query if url.query else ''),
                             method=method, body=payload.get('body'), extra_headers=payload.get('headers'))
        response_headers = meta.pop('responseHeaders')
        print(json.dumps({'status': meta['status'], 'headers': response_headers,
                          'text': data.decode('utf-8'), 'network': {**meta, 'dnsServer': args.dns_server}}))
    except Exception as exc:
        print(json.dumps({'errorType': type(exc).__name__, 'errorCode': getattr(exc, 'winerror', None) or getattr(exc, 'errno', None)}))
        sys.exit(1)
    sys.exit(0)

for host, path in [('slack.com', '/api/api.test'), ('mcp.slack.com', '/mcp')]:
    stage = 'dns'
    try:
        ips = dns_query(host)
        if not ips:
            raise RuntimeError('no_dns_A_answers')
        stage = 'https'
        meta, data = request(ips[0], host, path)
        rows.append({**meta, 'dnsPhysicalInterface': args.interface,
                     'dnsServer': args.dns_server, 'dnsAnswers': ips, 'authenticated': False})
    except Exception as exc:
        rows.append({'host': host, 'interface': args.interface, 'stage': stage, 'errorType': type(exc).__name__,
                     'errorCode': getattr(exc, 'winerror', None) or getattr(exc, 'errno', None)})
    print(json.dumps(rows[-1]), flush=True)

dest = Path(__file__).resolve().parent.parent / 'state/slack-transport-experiment-20261112/physical-egress-system-dns.json'
dest.write_text(json.dumps({'atUnix': time.time(), 'probes': rows}, indent=2) + '\n', encoding='utf-8')
