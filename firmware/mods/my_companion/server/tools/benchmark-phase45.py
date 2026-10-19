#!/usr/bin/env python3
"""Explicit paid benchmark. Existing server loader reads secrets; never handle or print them here.
Usage from firmware: python3 mods/my_companion/server/tools/benchmark-phase45.py WAV RESULT_DIRECTORY
At most 80 responses, no failed-batch retry. Existing finite connection retry remains active.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

if len(sys.argv) != 3:
    raise SystemExit('Usage: benchmark-phase45.py WAV NEW_RESULT_DIRECTORY')
wav = str(Path(sys.argv[1]).resolve(strict=True))
out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=False)
models = ['qwen3.5-omni-flash-realtime', 'qwen3.5-omni-plus-realtime', 'gpt-realtime-2.1-mini', 'gpt-realtime-2.1']
base = dict(os.environ, AI_REALTIME_PROVIDER='apiyi', REALTIME_PROVIDER='apiyi', AI_REALTIME_INSTRUCTIONS='请用简短的一句中文回答，不超过十五个字。')
for model in models:
    for chunk in [20, 40]:
        for batch in range(2):
            name = f'{model}-{chunk}ms-{batch}'
            env = dict(base, AI_REALTIME_MODEL=model, AI_REALTIME_VAD='server_vad' if model.startswith('qwen') else 'semantic_vad', ACCEPTANCE_CHUNK_MS=str(chunk), ACCEPTANCE_OUTPUT_CHUNK_MS=str(chunk))
            command = ['node', '--import', './mods/my_companion/simulator/register.js', 'mods/my_companion/server/acceptance.js'] + [wav]*5
            started = time.monotonic()
            with (out/(name+'.jsonl')).open('x') as output:
                try:
                    result = subprocess.run(command, env=env, stdout=output, stderr=subprocess.DEVNULL, timeout=160)
                    code = result.returncode
                except subprocess.TimeoutExpired:
                    code = 'PROCESS_TIMEOUT'
            print(json.dumps(dict(group=name, exit=code, elapsed_ms=round((time.monotonic()-started)*1000))), flush=True)
            if code != 0:
                break
