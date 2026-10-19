#!/usr/bin/env python3
"""Recompute Phase46 measurements from sanitized immutable JSONL and per-turn traces.
No networking, secret loading, missing-usage estimation or clock conversion.
Usage: summarize-phase46.py RESULT_DIRECTORY
"""
from pathlib import Path
import json, math, sys

MODELS=['qwen3.5-omni-flash-realtime','qwen3.5-omni-plus-realtime','gpt-realtime-2.1-mini','gpt-realtime-2.1']
def stats(values):
 data=sorted(v for v in values if isinstance(v,(int,float)) and math.isfinite(v))
 return None if not data else dict(n=len(data),min=data[0],p50=data[math.ceil(len(data)*.5)-1],p95=data[math.ceil(len(data)*.95)-1],max=data[-1])
def delta(t,end,start):
 a,b=t.get(end),t.get(start)
 return None if a is None or b is None else a-b

def summarize(out):
 rows=[]; traces=[]; empty=[]
 for f in sorted(out.glob('*.jsonl')):
  if f.name=='live-exits.jsonl':continue
  if not f.stat().st_size:empty.append(f.name)
  for n,line in enumerate(f.read_text().splitlines(),1):
   r=json.loads(line)
   if r.get('evidence')!='LINUX_REAL_API':continue
   rows.append(dict(r,source=f.name,line=n))
 for f in sorted(out.glob('*.trace.json')):
  t=json.loads(f.read_text());t['source']=f.name;traces.append(t)
 main=[r for r in rows if any(r['source'].startswith(m+'-') for m in MODELS) or r['source']=='qwen-plus-original-60s-replay.jsonl']
 result={'evidence':'LINUX_REAL_API','clock':'local performance.now, nearest-rank percentiles','counts':{},'models':{},'failures':[],'empty_artifacts':empty}
 for name,items in [('main',main),('all_saved_trials',rows)]:
  failed=[r for r in items if r.get('error')]
  result['counts'][name]={'attempts':len(items),'successes':len(items)-len(failed),'failures':len(failed),'timeouts':sum('TIMEOUT' in r.get('error','') or r.get('error')=='STREAM_STALLED' for r in failed),'success_rate':(len(items)-len(failed))/len(items) if items else None}
 for r in rows:
  if r.get('error'):
   result['failures'].append({k:r.get(k) for k in ['source','line','model','requestId','mode','error','session_error','server_error','provider_connection_attempts','queue','output_queue_bytes','response_done','events']})
 for model in MODELS:
  short=[r for r in main if r.get('model')==model and '-short-' in r['source']]
  long=[r for r in main if r.get('model')==model and '-long-' in r['source']]
  before=[r for r in rows if r['source']=='before-'+model+'.jsonl']
  ts=[t for t in traces if t.get('model')==model and (t['source'].startswith(model+'-barge-') or t['source']=='retest-mini-barge-completion.trace.json')]
  turns=[turn for t in ts for turn in t['turns'] if turn.get('firstCandidateAt') is not None and turn.get('detectedAt') is not None]
  reconnect=[r for r in rows if r.get('model')==model and r.get('mode')=='reconnect' and r.get('reconnect_latency') is not None and not r.get('error')]
  next_audio=[]
  for trace in ts:
   for turn in trace['turns']:
    if turn.get('firstCandidateAt') is None or turn.get('detectedAt') is None:continue
    fresh=[t for t in trace['turns'] if t['sessionId']==turn['sessionId'] and t['turnId']>turn['turnId'] and t.get('firstAudioAt') is not None and t['firstAudioAt']>=turn['detectedAt']]
    if fresh:next_audio.append(min(t['firstAudioAt'] for t in fresh)-turn['detectedAt'])
  result['models'][model]={
   'short':{'attempts':len(short),'successes':sum(not r.get('error') for r in short),'provider_ttfa_ms':stats([r.get('provider_TTFA') for r in short if not r.get('error')]),'e2e_ttfa_ms':stats([r.get('E2E_TTFA') for r in short if not r.get('error')]),'server_forward_ms':stats([r.get('server_forward_latency') for r in short]),'simulator_schedule_ms':stats([r.get('device_buffer_latency') for r in short]),'response_latency_ms':stats([r.get('response_latency_v45') for r in short]),'playback_completion_ms':stats([r.get('playback_completion_latency') for r in short]),'usage':[r.get('usage') for r in short]},
   'long':[{'source':r['source'],**{k:r.get(k) for k in ['error','T0','T4','response_done','output_playback_completed','provider_output_bytes','device_audio_bytes','played_audio_bytes','queue','usage']}} for r in long],
   'interruption':{'hint_turn_samples':len(turns),'provider_mode_file_to_detect_ms':stats([r.get('barge_detection_latency') for r in before]),'pcm_mode_file_to_detect_ms':stats([r.get('barge_detection_latency') for r in main if r.get('model')==model and '-barge-' in r['source']]),'candidate_to_detect_ms':stats([delta(t,'detectedAt','firstCandidateAt') for t in turns]),'detect_to_stop_call_ms':stats([delta(t,'stopInvokedAt','detectedAt') for t in turns]),'detect_to_buffer_clear_ms':stats([delta(t,'bufferClearedAt','detectedAt') for t in turns]),'cancel_sent_to_ack_ms':stats([delta(t,'cancelAcknowledgedAt','cancelSentAt') for t in turns]),'detect_to_input_resumed_ms':stats([delta(t,'inputResumedAt','detectedAt') for t in turns]),'old_audio_leakage_bytes':sum(t['oldLeakBytes'] for t in turns),'cancel_reasons':[t.get('cancelReason') for t in turns],'detect_to_next_response_first_audio_ms':stats(next_audio)},
   'reconnect_ms':stats([r.get('reconnect_latency') for r in reconnect]),
   'queue_peak_bytes':max([r.get('max_server_queue_bytes',0) or 0 for r in main if r.get('model')==model]+[0]),
   'client_queue_peak_bytes':max([r.get('max_client_buffer_bytes',0) or 0 for r in main if r.get('model')==model]+[0])}
 result['connection_attempts_observed']=sum(max([r.get('provider_connection_attempts',0) or 0 for r in rows if r['source']==source]+[0]) for source in set(r['source'] for r in rows))
 result['response_created_events_observed']=sum(sum(e.get('type')=='response_created' for e in r.get('events',[])) for r in rows)
 result['long_turns']=[]
 for t in traces:
  if '-long-' not in t['source']:continue
  for turn in t['turns']:
   if turn.get('providerBytes'):
    result['long_turns'].append(dict(source=t['source'],model=t['model'],**turn))
 # ws output pressureCount is cumulative per connection; max per source+session, never sum repeated trial snapshots.
 result['pressure']={'failure_codes':[r.get('server_error') or r.get('session_error') for r in rows if (r.get('server_error') or r.get('session_error')) in ['OUTPUT_BACKPRESSURE','BUFFER_OVERFLOW','OUTPUT_CAPACITY_EXCEEDED','OUTPUT_CONSUMER_STALLED']], 'per_trace_turn_pressure_count':sum(turn.get('pressureCount',0) for t in traces for turn in t['turns'])}
 result['resources']=[dict(source=t['source'],**t['resources'],providerConnectionAttempts=t.get('providerConnectionAttempts')) for t in traces]
 (out/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 return result
if __name__=='__main__':
 s=summarize(Path(sys.argv[1]));print(json.dumps(s['counts']))
 for model,r in s['models'].items():print(model,json.dumps({'short':{k:v for k,v in r['short'].items() if k!='usage'},'interruption':r['interruption'],'reconnect_ms':r['reconnect_ms']}))
