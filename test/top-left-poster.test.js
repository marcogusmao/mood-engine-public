'use strict';
const test=require('node:test'),a=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('top left: real Pillow geometry and decoded JPEG at 342, 150 and client reduction',()=>{
 const result=spawnSync('python3',['-B','-c',String.raw`
import sys, os, io
sys.path.insert(0,'tools/selo')
from PIL import Image, ImageDraw, ImageChops
from selo import aplicar_v2, layout, pilula_esquerda, flag_badge, bookmark, _fit
raw=Image.open('test/fixtures/learning/cover.jpg').convert('RGB')
white=Image.new('RGBA',(80,53),(255,255,255,255))
def jpg(im):
    stream=io.BytesIO(); im.convert('RGB').save(stream,format='JPEG',quality=82,optimize=True)
    stream.seek(0); decoded=Image.open(stream); decoded.load(); return decoded.convert('RGB')
import tempfile
PROOF=tempfile.mkdtemp(prefix='top-left-proof-')  # 13/10/2026: nothing is written under the repo's .context by a test
for width in (342,150):
    L=layout(width); m=L['margin']; hb=int(L['h']*.8); pad=L['pad']
    for own in (False,True):
        for numbers in (False,True):
            opts={'largura':width,'na_watchlist':own}
            if numbers: opts.update(lb=4.2,imdb=8,amigos=3,n_viram=1)
            base=aplicar_v2(raw,**opts).convert('RGB')
            marker_width=int(pad*.8+_fit(bookmark(64),int(hb*.6)).width+pad*.8) if own else 0
            right=width-m-marker_width if own else width-m
            for year,flag in ((1954,white),(1954,None),(None,white),(None,None)):
                im=aplicar_v2(raw,ano=year,bandeira=flag,**opts).convert('RGB')
                tri=pilula_esquerda(ImageDraw.Draw(Image.new('RGBA',im.size)),width,m,hb,pad,year,flag,right)
                diff=ImageChops.difference(base,im); bounds=diff.getbbox()
                if year or flag is not None:
                    assert bounds, 'top left absent'
                    assert tri['text']==('1954' if year else ''), 'truncated year'
                    assert tri['x']+tri['w']+m<=right, 'collision with bookmark'
                    assert bounds[0]>=m and bounds[1]>=m and bounds[2]<=m+tri['w']+1 and bounds[3]<=m+hb+1, bounds
                    if flag is not None:
                        pic=tri['flag']; assert pic.getpixel((pic.width//2,pic.height//2))[:3]==(255,255,255), 'white flag lost'
                        blue=flag_badge(Image.new('RGBA',(80,53),(0,0,255,255)),pic.height)
                        assert blue.getpixel((blue.width//2,0))[0]>0, 'border missing'
                        assert blue.getpixel((blue.width//2,blue.height//2))[0]<blue.getpixel((blue.width//2,0))[0], 'border has no distinct rim'
                    outside=im.copy();outside.paste(base.crop((0,0,m+tri['w']+2,m+hb+2)),(0,0))
                    assert ImageChops.difference(outside,base).getbbox() is None, 'pixels outside left pill changed'
                else: assert bounds is None and tri is None
                decoded=jpg(im); assert decoded.size==(width,round(width*1.5))
                decoded_base=jpg(base)
                if year or flag is not None:
                    assert ImageChops.difference(decoded,decoded_base).crop((0,0,width//2,m+hb+3)).getbbox(), 'JPEG top left absent'
                    assert decoded.crop((width//2,0,width,m+hb+8)).tobytes()==decoded_base.crop((width//2,0,width,m+hb+8)).tobytes(), 'JPEG bookmark changed'
                if own and numbers:
                    name=('year-flag' if year and flag is not None else 'year' if year else 'flag' if flag is not None else 'none')
                    decoded.save(PROOF+'/synthetic-%s-%d.png'%(name,width))
                    if width==342:
                        reduced=decoded.resize((150,225),Image.LANCZOS)
                        reduced.save(PROOF+'/synthetic-%s-client150.png'%name)
                        if year or flag is not None:
                            assert ImageChops.difference(reduced,decoded_base.resize((150,225),Image.LANCZOS)).crop((0,0,60,24)).getbbox(), 'client top left absent'
print('32 state combinations: geometry, year text, white border, bookmark clearance, unchanged outside pixels, JPEG dimensions and client reduction passed')
`],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'});
 a.equal(result.status,0,result.stdout+result.stderr);
});
