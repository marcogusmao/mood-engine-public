import struct, io
import importlib.util, pathlib, tempfile, unittest, zipfile
spec=importlib.util.spec_from_file_location('intake',pathlib.Path(__file__).resolve().parents[1]/'scripts/validate-letterboxd-export.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ExportTests(unittest.TestCase):
 def archive(self,replace=None,entries=None):
  tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);p=pathlib.Path(tmp.name)/'input.zip'
  base='Date,Name,Year,Letterboxd URI\n'
  files={'profile.csv':'Username,Email\nfriend-a,PRIVATE-CANARY\n','watched.csv':base,'ratings.csv':base.rstrip('\n')+',Rating\n','watchlist.csv':base,'diary.csv':base.rstrip('\n')+',Rating,Rewatch,Tags,Watched Date\n'}
  files.update(replace or {})
  with zipfile.ZipFile(p,'w') as z:
   for k,v in files.items():z.writestr(k,v)
   for k,v in entries or []:z.writestr(k,v)
  return p
 def parse(self,p):return m.parse(p,'2026-10-14T12:00:00.000Z','11111111-1111-4111-8111-111111111111')
 def test_empty_and_missing_optional(self):
  h=self.parse(self.archive());self.assertEqual(h['watched'],[]);self.assertEqual(h['coverage']['likes']['state'],'unknown');self.assertNotIn('PRIVATE',str(h))
 def test_profile(self):
  for profile in ['Username\nmarco\n','User\nfriend-a\n']:
   with self.assertRaises(m.Invalid):self.parse(self.archive({'profile.csv':profile}))
 def test_paths(self):
  for name in ['../escape','/absolute','a\\b','WATCHED.CSV','watched.csv/inside','C:/file']:
   with self.assertRaises(m.Invalid):self.parse(self.archive(entries=[(name,'x')]))
 def test_values(self):
  for value in ['NaN','inf','4.3','0','6']:
   with self.assertRaises(m.Invalid):self.parse(self.archive({'ratings.csv':'Date,Name,Year,Letterboxd URI,Rating\n2026-10-01,Film,2000,https://boxd.it/abc,'+value+'\n'}))
 def test_quotes_headers(self):
  for raw in ['Date,Name,Year,Letterboxd URI\n2026-01-01,"unclosed,2000,url','Date,Name,Name,Letterboxd URI\n']:
   with self.assertRaises(m.Invalid):self.parse(self.archive({'watched.csv':raw}))
 def test_crc(self):
  p=self.archive({'watched.csv':'Date,Name,Year,Letterboxd URI\n2026-01-01,Film,2000,https://boxd.it/abc\n'});b=p.read_bytes();i=b.index(b'2026-01-01');p.write_bytes(b[:i]+b'X'+b[i+1:])
  with self.assertRaises(m.Invalid):self.parse(p)
 def test_inflated(self):
  p=self.archive()
  with zipfile.ZipFile(p,'a',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('likes/films.csv','A'*2000000)
  with self.assertRaises(m.Invalid):self.parse(p)
 def test_stream_bound(self):
  old=m.MAX_ARCHIVE;m.MAX_ARCHIVE=1
  try:
   with self.assertRaises(m.Invalid):self.parse(self.archive())
  finally:m.MAX_ARCHIVE=old

 def test_actual_stream_bound_before_final_size_check(self):
  p=self.archive()
  with zipfile.ZipFile(p,'a',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('likes/films.csv','A'*3000000)
  with zipfile.ZipFile(p) as z:entry=z.getinfo('likes/films.csv');offset=entry.header_offset
  raw=bytearray(p.read_bytes());struct.pack_into('<L',raw,offset+22,4096)
  start=raw.find(b'PK\x01\x02',offset)
  while start>=0:
   n=struct.unpack_from('<H',raw,start+28)[0]
   if raw[start+46:start+46+n]==b'likes/films.csv':struct.pack_into('<L',raw,start+24,4096);break
   start=raw.find(b'PK\x01\x02',start+4)
  p.write_bytes(raw)
  with self.assertRaisesRegex(m.Invalid,'ZIP_INFLATED_LIMIT'):self.parse(p)

 def test_missing_data_descriptor(self):
  p=self.archive();raw=bytearray(p.read_bytes())
  # A central/local bit-3 claim with no descriptor cannot borrow the next header.
  struct.pack_into('<H',raw,6,8);struct.pack_into('<3L',raw,14,0,0,0)
  central=raw.index(b'PK\x01\x02');struct.pack_into('<H',raw,central+8,8);p.write_bytes(raw)
  with self.assertRaisesRegex(m.Invalid,'ZIP_DESCRIPTOR_INVALID'):self.parse(p)

 def test_streaming_descriptors(self):
  class Stream(io.BytesIO):
   def seek(self,*args): raise io.UnsupportedOperation()
  p=self.archive()
  with zipfile.ZipFile(p) as z: files={i.filename:z.read(i) for i in z.infolist()}
  stream=Stream()
  with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_DEFLATED) as z:
   for name,data in files.items():z.writestr(name,data)
  raw=stream.getvalue();p.write_bytes(raw);self.assertEqual(self.parse(p)['personId'],'friend-a')
  descriptor=raw.index(b'PK\x07\x08')
  for field in [4,8,12]:
   bad=bytearray(raw);bad[descriptor+field]^=1;p.write_bytes(bad)
   with self.assertRaisesRegex(m.Invalid,'ZIP_DESCRIPTOR_INVALID'):self.parse(p)
  # Last descriptor cut short while the directory offset is truthful.
  last=raw.rindex(b'PK\x07\x08');cut=raw[:last+8]+raw[last+16:];bad=bytearray(cut)
  eocd=bad.rindex(b'PK\x05\x06');struct.pack_into('<L',bad,eocd+16,struct.unpack_from('<L',bad,eocd+16)[0]-8);p.write_bytes(bad)
  with self.assertRaisesRegex(m.Invalid,'ZIP_DESCRIPTOR_INVALID'):self.parse(p)
