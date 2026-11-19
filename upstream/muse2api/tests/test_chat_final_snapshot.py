import ast, threading
from pathlib import Path
source=Path(__file__).parents[1]/'app.py'
module=ast.parse(source.read_text(encoding='utf-8-sig'))
fn=next(n for n in module.body if isinstance(n,ast.FunctionDef) and n.name=='safe_chat_stream')
class Engine:
    def start(self): pass
    def chat_stream(self,*args,**kwargs):
        yield '{"nodes":'
        yield '{"nodes":[{"id":"a"}]}'
    def _poll_chat(self): return (1,'{"nodes":[{"id":"a"}]}',False)
    def close_current_page(self): pass
    def reset_thread(self): pass
scope={'threading':threading,'engine':Engine(),'GEN_LOCK':threading.Lock(),'_clear_account_proxy':lambda:None,'MuseAuthError':type('AuthError',(Exception,),{})}
exec(compile(ast.Module(body=[fn],type_ignores=[]),str(source),'exec'),scope)
run=scope['safe_chat_stream']
assert ''.join(run({},'test',None,5,None,final_only=True))=='{"nodes":[{"id":"a"}]}'
assert len(list(run({},'test',None,5,None)))==2
print('PASS: final JSON snapshot replaces overwritten DOM chunks; streaming still returns deltas')

# A structured response may pause for more than five seconds while the web
# composer still shows Stop. Non-streaming callers must wait for completion.
engine_tree=ast.parse((source.parent/'engine.py').read_text(encoding='utf-8-sig'))
ready=next(n for n in ast.walk(engine_tree) if isinstance(n,ast.FunctionDef) and n.name=='_chat_stream_ready')
class Clock:
    def __init__(self): self.value=0
    def time(self): return self.value
    def sleep(self,delta): self.value+=delta
clock=Clock()
class Poller:
    def __init__(self): self.sent=False; self.last=''
    def _send(self,prompt): self.sent=True
    def _poll_chat(self):
        if not self.sent:return (0,'',False)
        if clock.time()<6:self.last='{"nodes":[';return (1,self.last,True)
        self.last='{"nodes":[1]}';return (1,self.last,False)
scope={'time':clock,'MuseGenerationError':RuntimeError}
exec(compile(ast.Module(body=[ready],type_ignores=[]),str(source),'exec'),scope)
poller=Poller()
list(scope['_chat_stream_ready'](poller,'test',20,wait_for_final=True))
assert clock.time()>7 and poller.last=='{"nodes":[1]}'
print('PASS: final response waits past five-second reasoning gap until Stop disappears')
