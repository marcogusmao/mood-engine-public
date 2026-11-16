#!/usr/bin/env python3
"""Bounded Letterboxd intake. Diagnostics contain fixed codes only."""
import binascii, zlib
import csv, datetime, io, json, os, pathlib, re, resource, stat, struct, sys, zipfile
MAX_ARCHIVE=8*1024*1024
KINDS={'watched.csv':'watched','ratings.csv':'ratings','watchlist.csv':'watchlist','diary.csv':'diary','likes/films.csv':'likes'}
BASE=['Date','Name','Year','Letterboxd URI']
class Invalid(Exception): pass
def need(ok,code='EXPORT_INVALID'):
    if not ok: raise Invalid(code)
def date(s, today):
    if not s: return None
    need(bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}',s)))
    try: d=datetime.date.fromisoformat(s)
    except ValueError: raise Invalid('EXPORT_INVALID_DATE')
    need(d<=today,'EXPORT_INVALID_DATE'); return s
def rating(s):
    if not s: return None
    need(bool(re.fullmatch(r'(?:[0-4](?:\.5|\.0)?|5(?:\.0)?)',s)) and float(s)>=.5,'EXPORT_INVALID_RATING')
    return float(s)
def quoting(text):
    state='start'; i=0
    while i<len(text):
        c=text[i]
        if state=='quoted':
            if c=='"':
                if i+1<len(text) and text[i+1]=='"': i+=1
                else: state='after'
        elif state=='after':
            need(c in ',\r\n','EXPORT_INVALID_CSV')
            state='start'
        elif c=='"':
            need(state=='start','EXPORT_INVALID_CSV');state='quoted'
        elif c in ',\r\n': state='start'
        else: state='plain'
        i+=1
    need(state!='quoted','EXPORT_INVALID_CSV')
def rows(raw, headers):
    try:
        text=raw.decode('utf-8-sig'); need('\x00' not in text); quoting(text)
        csv.field_size_limit(8192)
        reader=csv.reader(io.StringIO(text,newline=''),strict=True)
        head=next(reader); need(len(head)<=32 and len(set(head))==len(head) and set(head)==set(headers),'EXPORT_SCHEMA_UNSUPPORTED')
        out=[]
        for row in reader:
            need(len(row)==len(head) and sum(len(s.encode('utf8')) for s in row)+max(0,len(row)-1)<=65536)
            need(all(len(s)<=8192 for s in row)); out.append(dict(zip(head,row))); need(len(out)<=50000,'EXPORT_ROW_LIMIT')
        return out
    except (UnicodeError,csv.Error,StopIteration): raise Invalid('EXPORT_INVALID_CSV')
def parse(src, captured, request):
    today=datetime.datetime.fromisoformat(captured.replace('Z','+00:00')).astimezone(datetime.timezone(datetime.timedelta(hours=-3))).date()
    need(os.path.getsize(src)<=MAX_ARCHIVE,'ZIP_TOO_LARGE')
    # ZIP64/multipart are never required for an 8 MiB export.
    archive=pathlib.Path(src).read_bytes()
    need(b'PK\x06\x06' not in archive and b'PK\x06\x07' not in archive,'ZIP_UNSUPPORTED')
    end=archive.rfind(b'PK\x05\x06'); need(end>=0 and end+22<=len(archive))
    eocd=struct.unpack_from('<4s4H2LH',archive,end)
    need(eocd[1]==eocd[2]==0 and eocd[3]==eocd[4] and end+22+eocd[-1]==len(archive),'ZIP_UNSUPPORTED')
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        infos=z.infolist(); need(len(infos)<=2048,'ZIP_ENTRY_LIMIT')
        names=set(); files=set(); dirs=set(); total=0; compressed=0; retained=0; bodies={}; ranges=[]
        for x in infos:
            name=x.filename; n=name.rstrip('/'); bits=n.split('/')
            need(n and not name.startswith('/') and '\\' not in name and '\x00' not in name and not re.match(r'^[A-Za-z]:',name) and all(p not in ('','.','..') for p in bits),'ZIP_PATH_INVALID')
            key=n.casefold(); need(key not in names,'ZIP_DUPLICATE_PATH'); names.add(key)
            mode=x.external_attr>>16; typ=stat.S_IFMT(mode)
            need(typ in (0,stat.S_IFDIR,stat.S_IFREG),'ZIP_TYPE_INVALID')
            need(not(x.flag_bits&1) and x.compress_type in (0,8),'ZIP_UNSUPPORTED')
            need(x.extract_version<45 and b'\x01\x00' not in x.extra[:2],'ZIP_UNSUPPORTED')
            total+=x.file_size; compressed+=x.compress_size
            need(total<=64*1024*1024 and total<=100*max(1,compressed),'ZIP_INFLATED_LIMIT')
            (dirs if x.is_dir() else files).add(key)
            for i in range(1,len(bits)): dirs.add('/'.join(bits[:i]).casefold())
            at=x.header_offset; need(at+30<=z.start_dir)
            local=struct.unpack_from('<4s5H3L2H',archive,at); need(local[0]==b'PK\x03\x04' and local[3]==x.compress_type and local[2]==x.flag_bits)
            namebytes=archive[at+30:at+30+local[-2]]
            need(namebytes.decode('utf8' if x.flag_bits&0x800 else 'cp437')==name)
            start=at+30+local[-2]+local[-1]; stop=start+x.compress_size
            end=stop
            if x.flag_bits&8:
                # Streaming ZIPs must carry their CRC and sizes after the body.
                # Both forms (with/without the optional signature) are valid.
                signed=archive[stop:stop+4]==b'PK\x07\x08'
                descriptor=stop+(4 if signed else 0); end=descriptor+12
                need(end<=z.start_dir,'ZIP_DESCRIPTOR_INVALID')
                need(struct.unpack_from('<3L',archive,descriptor)==(x.CRC,x.compress_size,x.file_size),'ZIP_DESCRIPTOR_INVALID')
                need(all(a in (0,b) for a,b in zip(local[6:9],(x.CRC,x.compress_size,x.file_size))),'ZIP_HEADER_MISMATCH')
            else: need(local[6:9]==(x.CRC,x.compress_size,x.file_size),'ZIP_HEADER_MISMATCH')
            need(end<=z.start_dir and all(end<=a or at>=b for a,b in ranges)); ranges.append((at,end))
            if name not in KINDS and name!='profile.csv': continue
            cap=65536 if name=='profile.csv' else 16*1024*1024
            need(x.file_size<=cap and (x.compress_size>0 or x.file_size==0) and x.file_size<=100*x.compress_size,'ZIP_INFLATED_LIMIT')
            chunks=[]; actual=0; crc=0
            decoder=zlib.decompressobj(-15) if x.compress_type==8 else None
            for off in range(start,stop,65536):
                pending=archive[off:min(off+65536,stop)]
                while pending:
                    chunk=decoder.decompress(pending,65536) if decoder else pending
                    pending=decoder.unconsumed_tail if decoder else b''
                    actual+=len(chunk); retained+=len(chunk); crc=binascii.crc32(chunk,crc)
                    need(actual<=cap and retained<=32*1024*1024 and actual<=100*x.compress_size,'ZIP_INFLATED_LIMIT'); chunks.append(chunk)
                    if decoder and decoder.eof: need(not decoder.unused_data and not pending,'ZIP_STREAM_INVALID')
            if decoder: need(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail,'ZIP_STREAM_INVALID')
            need(actual==x.file_size,'ZIP_HEADER_MISMATCH'); need(crc==x.CRC,'ZIP_CRC_INVALID'); bodies[name]=b''.join(chunks)
        need(not(files&dirs),'ZIP_PATH_OVERLAP')
    need('profile.csv' in bodies,'EXPORT_PROFILE_UNSUPPORTED')
    # Profile is used only to check Username; all other fields are discarded.
    try:
        profile_text=bodies['profile.csv'].decode('utf-8-sig'); quoting(profile_text); need('\x00' not in profile_text,'EXPORT_PROFILE_UNSUPPORTED')
        reader=csv.reader(io.StringIO(profile_text,newline=''),strict=True); headers=next(reader)
        need(len(headers)<=32 and len(set(headers))==len(headers),'EXPORT_PROFILE_UNSUPPORTED')
        profile_rows=list(reader); need(all(len(r)==len(headers) and all(len(v)<=8192 for v in r) for r in profile_rows),'EXPORT_PROFILE_UNSUPPORTED')
        profile=[dict(zip(headers,r)) for r in profile_rows]
        need(len(profile)==1 and 'Username' in profile[0] and profile[0]['Username'].isascii() and profile[0]['Username'].lower()=='friend-a','EXPORT_PROFILE_UNSUPPORTED')
    except (UnicodeError,csv.Error,StopIteration): raise Invalid('EXPORT_PROFILE_UNSUPPORTED')
    out=dict(schemaVersion=1,personId='friend-a',letterboxdUser='friend-a',importedAt=captured,sourceRequestId=request,coverage={})
    count=0
    for name,kind in KINDS.items():
        need(name in bodies or kind=='likes','EXPORT_REQUIRED_FILE')
        out[kind]=[]; out['coverage'][kind]={'state':'complete' if name in bodies else 'unknown','source':'export'}
        if name not in bodies: continue
        headers=BASE+(['Rating'] if kind=='ratings' else ['Rating','Rewatch','Tags','Watched Date'] if kind=='diary' else [])
        records=rows(bodies[name],headers); count+=len(records); need(count<=100000,'EXPORT_ROW_LIMIT'); seen={}
        for ordinal,r in enumerate(records):
            title=r['Name']; need(0<len(title)<=512)
            yr=r['Year']; need(not yr or bool(re.fullmatch(r'\d{4}',yr)) and 1850<=int(yr)<=2100)
            uri=r['Letterboxd URI']; need(bool(re.fullmatch(r'https://(?:boxd\.it/[A-Za-z0-9]+|letterboxd\.com/film/[a-z0-9][a-z0-9-]*/)',uri)),'EXPORT_URI_INVALID')
            item=dict(uri=uri,title=title,year=int(yr) if yr else None,date=date(r['Date'],today))
            if kind in ('ratings','diary'): item['rating']=rating(r['Rating'])
            if kind=='diary':
                need(r['Rewatch'] in ('','Yes','No')); item.update(entryId='zip:'+str(ordinal),watchedDate=date(r['Watched Date'],today),rewatch=r['Rewatch']=='Yes')
            elif uri in seen:
                need(seen[uri]==item,'EXPORT_IDENTITY_CONFLICT'); continue
            seen[uri]=item; out[kind].append(item)
    return out
if __name__=='__main__':
    try:
        if sys.platform.startswith('linux'): resource.setrlimit(resource.RLIMIT_AS,(256*1024*1024,256*1024*1024))
        value=parse(sys.argv[1],sys.argv[3],sys.argv[4])
        fd=os.open(sys.argv[2],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w',encoding='utf8') as f: json.dump(value,f,ensure_ascii=False,separators=(',',':'),allow_nan=False)
    except Exception as e:
        print(str(e) if isinstance(e,Invalid) else 'EXPORT_INVALID',file=sys.stderr); sys.exit(1)
