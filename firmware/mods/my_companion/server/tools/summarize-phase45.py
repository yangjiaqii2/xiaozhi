#!/usr/bin/env python3
"""Summarize sanitized real acceptance JSONL; never estimate remote clocks or missing usage."""
from pathlib import Path
import json
import math
import sys

def stats(values):
    data=sorted(x for x in values if isinstance(x,(int,float)) and math.isfinite(x))
    if not data:return None
    return {'n':len(data),'min':data[0],'p50':data[math.ceil(len(data)*.5)-1],'p95':data[math.ceil(len(data)*.95)-1],'max':data[-1]}

def summarize(directory):
    groups={};scenarios=[];invalid=[]
    for file in sorted(directory.glob('*.jsonl')):
        if not (file.name.startswith('scenario-') or '-realtime-' in file.name):continue
        for number,line in enumerate(file.read_text().splitlines(),1):
            try:record=json.loads(line)
            except json.JSONDecodeError:
                invalid.append({'file':file.name,'line':number});continue
            record['source']=file.name
            if file.name.startswith('scenario-'):
                scenarios.append(record);continue
            key=f"{record.get('model',file.name)}:{record.get('chunk_ms','unknown')}ms"
            groups.setdefault(key,[]).append(record)
    result={}
    for key,rows in groups.items():
        good=[r for r in rows if not r.get('error') and not r.get('server_error') and r.get('stream_completed') is not None]
        result[key]={'attempts':len(rows),'successes':len(good),'failures':len(rows)-len(good),
        'provider_ttfa_ms':stats([r.get('provider_TTFA_v45') for r in good]),'e2e_ttfa_ms':stats([r.get('E2E_TTFA') for r in good]),
        'input_end_to_response_created_ms':stats([r['response_start']-r['T0'] for r in good if r.get('response_start') is not None and r.get('T0') is not None]),
        'adapter_observed_output_bytes_per_second':stats([r['provider_output_bytes']*1000/(r['response_done']-r['T4']) for r in good if r.get('response_done') and r.get('T4') and r['response_done']>r['T4']]),
        'server_forward_ms':stats([r.get('server_forward_latency') for r in good]),'simulator_schedule_ms':stats([r.get('device_buffer_latency') for r in good]),
        'response_completion_ms':stats([r.get('response_latency_v45') for r in good]),
        'playback_completion_ms':stats([r.get('playback_completion_latency') for r in good if r.get('measurement_version') in ['45.2','45.3','45.4']]),
        'cpu_user_us':stats([r.get('cpu',{}).get('user') for r in good]),
        'queue_peak_bytes':max([(r.get('queue') or {}).get('peakBytes',0) for r in rows]+[0]),
        'temporary_pressure_count_session_max':max([(r.get('queue') or {}).get('pressureCount',0) for r in rows]+[0]),
        'permanent_pressure_failures':sum(r.get('server_failure')=='OUTPUT_BACKPRESSURE' or r.get('server_error') in ['OUTPUT_CAPACITY_EXCEEDED','OUTPUT_CONSUMER_STALLED'] for r in rows),
        'first_audio_before_done':all(r.get('first_audio_before_done') is True for r in good),
        'usage_samples':[r.get('usage') for r in good],
        'errors':[r.get('error') or r.get('server_error') for r in rows if r not in good]}
    summary={'evidence':'LINUX_REAL_API','percentiles':'nearest rank','groups':result,'scenarios':scenarios,'malformed_result_lines':invalid,
       'trial_counts':{'short_attempts':sum(g['attempts'] for g in result.values()),'short_successes':sum(g['successes'] for g in result.values()),'special_trials':len(scenarios),'special_failures':sum(bool(r.get('error')) for r in scenarios)},
       'scope':'Local monotonic clocks only; provider remote timestamps and actual acoustic playback remain unobserved. Queue pressure counts are cumulative per WS session, not per response.'}
    (directory/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    return summary

if __name__=='__main__':
    summary=summarize(Path(sys.argv[1]))
    for key,g in summary['groups'].items():
        print(json.dumps({'group':key,**{k:v for k,v in g.items() if k not in ['usage_samples']}},ensure_ascii=False))
