"""Build public, secret-free source installer assets from the tracked checkout."""
import argparse, hashlib, io, json, pathlib, subprocess, tarfile, zipfile
root=pathlib.Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--output',default='dist-release');args=parser.parse_args()
out=(root/args.output).resolve();out.mkdir(parents=True,exist_ok=True)
names=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode('utf-8').split('\0')
files=[]
for name in filter(None,names):
    file=root/name
    if not file.is_file():continue
    parts=pathlib.PurePosixPath(name).parts
    if '.env' in parts or 'node_modules' in parts or '.git' in parts or 'instances' in parts or 'data' in parts or '.venv' in parts:
        raise SystemExit('Refusing to package runtime/secret file: '+name)
    files.append(name)
def content(file):
    data=file.read_bytes()
    try:data.decode('utf-8')
    except UnicodeDecodeError:return data
    return data.replace(b'\r\n',b'\n')
archive=out/'musecanvas-install.tar.gz'
with tarfile.open(archive,'w:gz') as tar:
    for name in files:
        file=root/name;data=content(file);info=tarfile.TarInfo('musecanvas/'+name)
        info.size=len(data);info.mode=0o755 if file.suffix=='.sh' else 0o644
        tar.addfile(info,io.BytesIO(data))
(out/'install.sh').write_bytes(content(root/'deploy/install.sh'))
extension=out/'musecanvas-account-binding.zip'
with zipfile.ZipFile(extension,'w',zipfile.ZIP_DEFLATED) as z:
    for name in files:
        if name.startswith('extension/'):z.writestr(name[len('extension/'):],content(root/name))
sums=[]
for file in [archive,out/'install.sh',extension]:sums.append(hashlib.sha256(file.read_bytes()).hexdigest()+'  '+file.name)
(out/'SHA256SUMS').write_text('\n'.join(sums)+'\n',encoding='utf-8',newline='\n')
print(json.dumps({'files':[p.name for p in [archive,out/'install.sh',extension,out/'SHA256SUMS']],'tracked_files':len(files),'archive_bytes':archive.stat().st_size}))
