"""Queue waits must not consume generation time; retries share one execution budget."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root))
with tempfile.TemporaryDirectory() as home:
    os.environ.update(MUSE2API_HOME=home,MUSE2API_PROFILE_ROOT=home,MUSE2API_KEY='test-only')
    spec=importlib.util.spec_from_file_location('budget_fixture',root/'app.py')
    app=importlib.util.module_from_spec(spec);sys.modules[spec.name]=app;spec.loader.exec_module(app)
    assert app.ImageRequest(prompt='fixture',timeout=1800).timeout==1800
    clock=SimpleNamespace(now=0.0)
    calls=[];acquired=[];released=[]
    class BrowserQueue:
        def acquire(self,timeout):
            assert timeout==1800
            clock.now+=900
            return True
        def release(self):released.append('browser')
    class Accounts:
        def acquire(self,**kwargs):
            assert kwargs['timeout']>=1
            clock.now+=200 if not kwargs.get('force_rotate') else 20
            return {'id':'second' if kwargs.get('force_rotate') else 'first','cookies':{}}
        def release(self,aid):released.append(aid)
    def generate(*args,**kwargs):
        calls.append(kwargs['timeout'])
        if len(calls)==1:
            clock.now+=60
            raise app.MuseGenerationError('temporary generation failure')
        return {'filename':'fixture.png','size':1,'kind':'image'}
    with patch.object(app,'time',SimpleNamespace(monotonic=lambda:clock.now)), \
         patch.object(app,'GEN_LOCK',BrowserQueue()),patch.object(app,'ACCOUNT_POOL',Accounts()), \
         patch.object(app.CFG,'queue_timeout',1800),patch.object(app,'_renew_and_persist',return_value=None), \
         patch.object(app.engine,'start'),patch.object(app.engine,'generate',side_effect=generate), \
         patch.object(app.engine,'reset_thread'),patch.object(app.engine,'close_current_page'), \
         patch.object(app.store,'mark'),patch.object(app,'_sync_cookies'):
        result,_=app._run_generation('fixture','image',600,on_acquired=lambda:acquired.append(clock.now))
    assert acquired==[1100],acquired
    assert calls==[600,520],calls
    assert released==['first','second','browser'],released
    assert result['filename']=='fixture.png'
print('PASS: 1100 seconds of queueing preserve 600 seconds of generation; retries stay bounded; leases released')
