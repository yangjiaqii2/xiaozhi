#!/usr/bin/env python3
"""Explicit paid Phase46 benchmark, at most 81 trials; no failed-batch retries.
Run from firmware: python3 .../benchmark-phase46.py WAV_DIRECTORY NEW_RESULT_DIRECTORY
Requires hello/stop/beijing/name/recall 16k mono S16LE WAVs. Never handles credentials.
"""
from pathlib import Path
import subprocess,json,os,time,sys
if len(sys.argv) != 3:
 raise SystemExit('Usage: benchmark-phase46.py WAV_DIRECTORY NEW_RESULT_DIRECTORY')
wavs=Path(sys.argv[1]).resolve(strict=True)
for clip in ['hello','stop','beijing','name','recall']:
 (wavs/(clip+'.wav')).resolve(strict=True)
out=Path(sys.argv[2]).resolve()
out.mkdir(parents=True,exist_ok=False)
models=['qwen3.5-omni-flash-realtime','qwen3.5-omni-plus-realtime','gpt-realtime-2.1-mini','gpt-realtime-2.1']
short='请用简短的一句中文回答，不超过十五个字。'
barge='用户要求介绍北京时请用五十字回答，其他问题简短回答，不超过十字。'
long='请用八十个中文字介绍北京的历史和景点。'
def run(model,name,mode,clips,instructions,hint='pcm'):
 trace=out/f'{name}.trace.json'
 env=dict(os.environ,REALTIME_ACTIVITY_HINT=hint,AI_REALTIME_MODEL=model,AI_REALTIME_VAD='server_vad' if model.startswith('qwen') else 'semantic_vad',AI_REALTIME_INSTRUCTIONS=instructions,ACCEPTANCE_MODE=mode,PHASE46_TRACE=str(trace.resolve()))
 cmd=['node','--import','./mods/my_companion/simulator/register.js','mods/my_companion/server/phase46-acceptance.js']+[str(wavs/(clip+'.wav')) for clip in clips]
 start=time.monotonic()
 with (out/f'{name}.jsonl').open('x') as f:
  try:r=subprocess.run(cmd,env=env,stdout=f,stderr=subprocess.DEVNULL,timeout=420);code=r.returncode
  except subprocess.TimeoutExpired:code='PROCESS_TIMEOUT'
 record={'case':name,'model':model,'mode':mode,'hint':hint,'planned_samples':1 if mode=='voice-interrupt' else len(clips),'exit':code,'elapsed_ms':round((time.monotonic()-start)*1000)}
 print(json.dumps(record),flush=True)
 with (out/'live-exits.jsonl').open('a') as f:f.write(json.dumps(record)+'\n')
 return code
for model in models:
 for n in range(2):run(model,f'{model}-short-{n}','normal',['hello']*5,short)
 for n in range(2):run(model,f'{model}-long-{n}','normal',['beijing'],long)
 for n in range(3):run(model,f'{model}-barge-{n}','voice-interrupt',['beijing','stop','hello'],barge)
 run(model,f'{model}-reconnect','reconnect',['hello']*2,short)
 run(model,f'{model}-multi','normal',['hello','name','recall'],short)
run(models[1],'qwen-plus-original-60s-replay','voice-interrupt',['beijing','stop'],long,'provider')
print('PHASE46_REAL_COMPLETE',flush=True)
