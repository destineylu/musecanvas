"""Build a self-contained Windows x64 ZIP from tracked files and official runtimes."""
import argparse, hashlib, json, os, pathlib, re, shutil, subprocess, urllib.request, zipfile

root = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', default='dist-release')
parser.add_argument('--node-version', default='24.22.3')
parser.add_argument('--python-version', default='3.13.17')
parser.add_argument('--resume', action='store_true')
parser.add_argument('--local-node', help='Optional local node.exe; verified against official SHASUMS')
args = parser.parse_args()
out = (root / args.output).resolve(); out.mkdir(parents=True, exist_ok=True)
stage = out / 'windows-stage' / 'musecanvas'
if stage.exists() and not args.resume:
    raise SystemExit('Staging directory exists. Use a fresh output directory to preserve existing builds.')
stage.mkdir(parents=True,exist_ok=True)
cache = out / 'runtime-downloads'; cache.mkdir(exist_ok=True)

def download(url, target):
    if target.exists(): return target
    print('Downloading '+target.name,flush=True)
    with urllib.request.urlopen(url, timeout=120) as response:
        data = response.read()
    target.write_bytes(data)
    return target

tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
for name in filter(None, tracked):
    parts = pathlib.PurePosixPath(name).parts
    if any(p in parts for p in ['.env','data','node_modules','.venv','instances']):
        raise SystemExit('Refusing runtime/secret file: ' + name)
    if not (name.startswith(('server/src/','shared/','upstream/muse2api/','extension/','docs/','deploy/windows/'))
            or name in ['start.ps1','stop.ps1','server/package.json','server/package-lock.json']
            or name.lower().startswith('license')): continue
    if '/tests/' in name or '/deploy/' in name or name.endswith('.env.example'): continue
    src = root/name
    if src.is_file():
        dst=stage/name; dst.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(src,dst)
for name in ['launch.ps1','README.txt']:
    dst=stage/'deploy/windows'/name;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/'deploy/windows'/name,dst)
for name in ['start.cmd','stop.cmd']:
    (stage/name).write_bytes((root/'deploy/windows'/name).read_bytes().replace(b'\r\n',b'\n').replace(b'\n',b'\r\n'))
shutil.copy2(root/'deploy/windows/README.txt',stage/'README-Windows.txt')
for script in stage.rglob('*.ps1'):
    script.write_text(script.read_text(encoding='utf-8-sig'),encoding='utf-8-sig',newline='\r\n')

npm=shutil.which('npm.cmd') or shutil.which('npm')
if not npm: raise SystemExit('Build machine needs npm; end users do not.')
subprocess.run([npm,'ci','--no-audit','--no-fund'],cwd=root/'web',check=True)
subprocess.run([npm,'run','build'],cwd=root/'web',check=True)
shutil.copytree(root/'web/dist',stage/'web/dist',dirs_exist_ok=True)
subprocess.run([npm,'ci','--omit=dev','--no-audit','--no-fund'],cwd=stage/'server',check=True)

node_name=f'node-v{args.node_version}-win-x64.zip'
base=f'https://nodejs.org/dist/v{args.node_version}/'
with urllib.request.urlopen(base+'SHASUMS256.txt',timeout=30) as r: sums=r.read().decode()
node_dir=stage/'runtime/node';node_dir.mkdir(parents=True,exist_ok=True)
if args.local_node:
    executable=pathlib.Path(args.local_node)
    expected=next(line.split()[0] for line in sums.splitlines() if line.split()[-1]=='win-x64/node.exe')
    if hashlib.sha256(executable.read_bytes()).hexdigest()!=expected: raise SystemExit('Local Node checksum mismatch')
    shutil.copy2(executable,node_dir/'node.exe')
    download(f'https://raw.githubusercontent.com/nodejs/node/v{args.node_version}/LICENSE',node_dir/'LICENSE')
else:
    node_zip=download(base+node_name,cache/node_name)
    expected=next(line.split()[0] for line in sums.splitlines() if line.split()[-1]==node_name)
    if hashlib.sha256(node_zip.read_bytes()).hexdigest()!=expected: raise SystemExit('Node checksum mismatch')
    with zipfile.ZipFile(node_zip) as z:
        for member in z.namelist():
            if member.rsplit('/',1)[-1] in ['node.exe','LICENSE']:
                (node_dir/member.rsplit('/',1)[-1]).write_bytes(z.read(member))

py_name=f'python-{args.python_version}-embed-amd64.zip'
py_zip=download(f'https://www.python.org/ftp/python/{args.python_version}/{py_name}',cache/py_name)
py_dir=stage/'runtime/python';py_dir.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(py_zip) as z:z.extractall(py_dir)
pth=next(py_dir.glob('python*._pth'))
pth.write_text(pth.read_text().replace('#import site','import site')+'\nLib/site-packages\n../../upstream/muse2api\n',encoding='utf-8')
subprocess.run([shutil.which('python') or 'python','-m','pip','install','--disable-pip-version-check',
    '--target',str(py_dir/'Lib/site-packages'),'--platform','win_amd64',
    '--python-version','.'.join(args.python_version.split('.')[:2]),'--only-binary=:all:',
    '--no-compile','-r',str(root/'upstream/muse2api/requirements.txt')],check=True)

archive=out/'musecanvas-windows-x64.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for p in sorted(stage.rglob('*')):
        if not p.is_file(): continue
        rel=p.relative_to(stage).as_posix()
        if rel.startswith(('docs/plans/','docs/prototypes/')) or p.name in ['Dockerfile','docker-compose.yml','.dockerignore','.gitignore']:
            continue
        if p.name=='.env' or rel.startswith(('server/data/','upstream/muse2api/data/','upstream/muse2api/profiles/')):
            raise SystemExit('Refusing to publish used workspace: '+rel)
        if '__pycache__' in p.parts or p.suffix=='.pyc': continue
        z.write(p,p.relative_to(stage.parent).as_posix())
(out/'SHA256SUMS').write_text(hashlib.sha256(archive.read_bytes()).hexdigest()+'  '+archive.name+'\n',encoding='utf-8',newline='\n')
print(json.dumps({'archive':str(archive),'bytes':archive.stat().st_size,'nodeSHA256Verified':True,'pythonSource':'python.org','stage':str(stage)}))
