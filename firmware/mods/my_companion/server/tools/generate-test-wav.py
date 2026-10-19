# 仅生成固定中文测试 WAV；不是产品 TTS，无网络请求、不读取凭证。
# API 签名依据 https://github.com/espeak-ng/espeak-ng/blob/master/src/include/espeak-ng/speak_lib.h
import ctypes as c, wave, pathlib, subprocess
lib=c.CDLL('libespeak-ng.so.1')
lib.espeak_Initialize.argtypes=[c.c_int,c.c_int,c.c_char_p,c.c_int]
lib.espeak_Initialize.restype=c.c_int
rate=lib.espeak_Initialize(2,50,None,0)
assert rate>0
lib.espeak_SetVoiceByName.argtypes=[c.c_char_p]
assert lib.espeak_SetVoiceByName(b'cmn')==0
lib.espeak_SetParameter(1,165,0)
CALLBACK=c.CFUNCTYPE(c.c_int,c.POINTER(c.c_short),c.c_int,c.c_void_p)
parts=[]
@CALLBACK
def collect(samples,count,events):
    if samples and count: parts.append(c.string_at(samples,count*2))
    return 0
lib.espeak_SetSynthCallback(collect)
lib.espeak_Synth.argtypes=[c.c_void_p,c.c_size_t,c.c_uint,c.c_int,c.c_uint,c.c_uint,c.c_void_p,c.c_void_p]
phrases={
 'hello':'你好，你叫什么？',
 'name':'我叫小明。',
 'recall':'我刚才叫什么？',
 'tired':'今天有点累啊，你陪我聊会儿。',
 'um':'嗯。',
 'yes':'对。',
 'pause':'我今天，想和你聊聊，最近工作有点忙。',
 'beijing':'请给我详细介绍一下北京。',
 'stop':'停一下。',
 'long':'今天我想和你聊一聊我的生活。最近工作比较忙，每天都要写很多代码，有时候感觉有点累。不过周末我打算去公园散步，看看花草，也想找朋友一起吃饭。你觉得这样安排怎么样？'
}
folder=pathlib.Path('/tmp/companion-acceptance-audio'); folder.mkdir(exist_ok=True)
for name,text in phrases.items():
    parts.clear(); data=text.encode()+b'\x00'
    assert lib.espeak_Synth(data,len(data),0,1,0,1,None,None)==0
    lib.espeak_Synchronize()
    source=folder/(name+'-source.wav'); target=folder/(name+'.wav')
    with wave.open(str(source),'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(rate); f.writeframes(b''.join(parts))
    subprocess.run(['ffmpeg','-v','error','-y','-i',str(source),'-ac','1','-ar','16000','-c:a','pcm_s16le',str(target)],check=True)
    with wave.open(str(target),'rb') as f: print(name,round(f.getnframes()/16000,2),'seconds')
lib.espeak_Terminate()

subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(folder/'long.wav'), '-af', 'atempo=1.2', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(folder/'long-18s.wav')], check=True)
