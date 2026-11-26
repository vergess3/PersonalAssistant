import sys
from reportlab.graphics.shapes import Drawing
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics import renderSVG
from PIL import Image, ImageDraw
text=sys.stdin.read()
qr=QrCodeWidget(text)
if len(sys.argv)>1:
    qr.qr.make()
    matrix=qr.qr.modules
    scale,border=12,4
    size=(len(matrix)+border*2)*scale
    image=Image.new('RGB',(size,size),'white')
    draw=ImageDraw.Draw(image)
    for row,line in enumerate(matrix):
        for col,dark in enumerate(line):
            if dark:
                x,y=(col+border)*scale,(row+border)*scale
                draw.rectangle([x,y,x+scale-1,y+scale-1],fill='black')
    image.save(sys.argv[1])
x0,y0,x1,y1=qr.getBounds()
d=Drawing(300,300,transform=[300/(x1-x0),0,0,300/(y1-y0),0,0])
d.add(qr)
sys.stdout.write(renderSVG.drawToString(d))

