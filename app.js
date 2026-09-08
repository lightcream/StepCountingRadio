(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const media = $('media');
  const playerStage = $('playerStage');
  const emptyState = $('emptyState');
  const audioPoster = $('audioPoster');
  const subtitleLayer = $('subtitleLayer');
  const playlistEl = $('playlist');
  const statusPill = $('statusPill');
  const bodyProgress = document.createElement('div');
  bodyProgress.className = 'body-progress-line';
  bodyProgress.innerHTML = '<i></i>';
  document.body.appendChild(bodyProgress);

  const state = {
    files: [],
    currentIndex: -1,
    objectUrls: new Map(),
    subtitles: [],
    subtitleIndex: 0,
    subtitleFileName: '',
    subtitleLock: false,
    subtitleVersion: 0,
    stepSensorOn: false,
    stepGrant: 15,
    grantRemaining: 0,
    pendingStep: false,
    settleWindow: 5,
    warmupEndsAt: 0,
    rate: 1,
    volume: 1,
    musicVolume: 0.6,
    beatThreshold: 0.55,
    jumpCooldown: 1.5,
    avoidStart: 0,
    avoidEnd: 0,
    shuffle: false,
    musicUrl: '',
    musicName: '',
    music: null,
    audioCtx: null,
    analyser: null,
    musicGain: null,
    beatRAF: 0,
    lastBeatAt: 0,
    prevEnergy: 0,
    peakHistory: [],
    settingsHidden: false,
    lastJumpAt: 0,
    stepDetector: { lastPeakAt: 0, baseline: 9.81, peak: false, count: 0 },
    pausedBySubtitle: false,
  };

  const storageKey = 'neonStepMedia.settings.v1';
  const stored = (() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; }
  })();
  Object.assign(state, stored);
  state.stepGrant = clamp(Number(state.stepGrant), 1, 180, 15);
  state.settleWindow = clamp(Number(state.settleWindow), 0, 30, 5);
  state.rate = clamp(Number(state.rate), .25, 4, 1);
  state.volume = clamp(Number(state.volume), 0, 1, 1);
  state.musicVolume = clamp(Number(state.musicVolume), 0, 1, .6);
  state.beatThreshold = clamp(Number(state.beatThreshold), .05, 1, .55);
  state.jumpCooldown = clamp(Number(state.jumpCooldown), .1, 15, 1.5);
  state.avoidStart = clamp(Number(state.avoidStart), 0, 30, 0);
  state.avoidEnd = clamp(Number(state.avoidEnd), 0, 30, 0);

  function clamp(v, min, max, fallback) { return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback; }
  function saveSettings() {
    const data = {
      stepGrant: state.stepGrant, settleWindow: state.settleWindow, rate: state.rate, volume: state.volume,
      musicVolume: state.musicVolume, beatThreshold: state.beatThreshold, jumpCooldown: state.jumpCooldown,
      avoidStart: state.avoidStart, avoidEnd: state.avoidEnd, shuffle: state.shuffle, settingsHidden: state.settingsHidden
    };
    try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch {}
  }
  function fmtTime(sec) {
    sec = Math.max(0, Number(sec) || 0);
    const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = Math.floor(sec % 60);
    return (h ? String(h).padStart(2,'0') + ':' : '') + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  }
  function setStatus(text) { statusPill.textContent = text; }

  function syncSetting(id, numId, setter, formatter) {
    const slider = $(id); const num = $(numId);
    const apply = (raw) => { const v = setter(raw); slider.value = v; num.value = v; formatter?.(v); saveSettings(); };
    slider.addEventListener('input', e => apply(e.target.value));
    num.addEventListener('input', e => apply(e.target.value));
    return { slider, num, apply };
  }

  const stepGrantCtrl = syncSetting('stepGrant','stepGrantNum', v => clamp(parseFloat(v),1,180,state.stepGrant), v => {
    state.stepGrant = v; $('stepGrantLabel').textContent = `${v}s`;
  });
  const settleCtrl = syncSetting('settleWindow','settleWindowNum', v => clamp(parseFloat(v),0,30,state.settleWindow), v => {
    state.settleWindow = v; $('settleWindowLabel').textContent = `${v}s`;
  });
  const rateCtrl = syncSetting('rate','rateNum', v => clamp(parseFloat(v),.25,4,state.rate), v => {
    state.rate = v; media.playbackRate = state.rate; $('rateLabel').textContent = `${v.toFixed(2)}×`;
  });
  const volumeCtrl = syncSetting('volume','volumeNum', v => clamp(parseFloat(v),0,1,state.volume), v => {
    state.volume = v; media.volume = state.volume; $('volumeLabel').textContent = `${Math.round(v*100)}%`;
    $('muteBtn').textContent = v === 0 ? '🔇' : '🔊';
  });
  const musicVolumeCtrl = syncSetting('musicVolume','musicVolumeNum', v => clamp(parseFloat(v),0,1,state.musicVolume), v => {
    state.musicVolume = v; if (state.musicGain) state.musicGain.gain.value = v; $('musicVolumeLabel').textContent = `${Math.round(v*100)}%`;
  });
  const thresholdCtrl = syncSetting('beatThreshold','beatThresholdNum', v => clamp(parseFloat(v),.05,1,state.beatThreshold), v => {
    state.beatThreshold = v; $('beatThresholdLabel').textContent = v.toFixed(2);
  });
  const cooldownCtrl = syncSetting('jumpCooldown','jumpCooldownNum', v => clamp(parseFloat(v),.1,15,state.jumpCooldown), v => {
    state.jumpCooldown = v; $('jumpCooldownLabel').textContent = `${v.toFixed(2)}s`;
  });
  const avoidStartCtrl = syncSetting('avoidStart','avoidStartNum', v => clamp(parseFloat(v),0,30,state.avoidStart), v => {
    state.avoidStart = v; $('avoidStartLabel').textContent = `${v} min`;
  });
  const avoidEndCtrl = syncSetting('avoidEnd','avoidEndNum', v => clamp(parseFloat(v),0,30,state.avoidEnd), v => {
    state.avoidEnd = v; $('avoidEndLabel').textContent = `${v} min`;
  });

  function initializeControls() {
    stepGrantCtrl.apply(state.stepGrant);
    settleCtrl.apply(state.settleWindow);
    rateCtrl.apply(state.rate);
    volumeCtrl.apply(state.volume);
    musicVolumeCtrl.apply(state.musicVolume);
    thresholdCtrl.apply(state.beatThreshold);
    cooldownCtrl.apply(state.jumpCooldown);
    avoidStartCtrl.apply(state.avoidStart);
    avoidEndCtrl.apply(state.avoidEnd);
    $('shuffleToggle').checked = !!state.shuffle;
    $('settingsPanel').classList.toggle('hidden', state.settingsHidden);
    updateBodyClass();
    updateAll();
  }
  initializeControls();

  function updateBodyClass() { document.body.classList.toggle('settings-collapsed', state.settingsHidden); }

  $('toggleSettingsBtn').addEventListener('click', () => {
    state.settingsHidden = !state.settingsHidden;
    $('settingsPanel').classList.toggle('hidden', state.settingsHidden);
    updateBodyClass(); saveSettings();
  });
  $('hideSettingsBtn').addEventListener('click', () => {
    state.settingsHidden = true;
    $('settingsPanel').classList.add('hidden'); updateBodyClass(); saveSettings();
  });

  $('shuffleToggle').addEventListener('change', e => { state.shuffle = e.target.checked; saveSettings(); renderPlaylist(); });

  $('mediaInput').addEventListener('change', async e => {
    const files = [...e.target.files];
    if (!files.length) return;
    addMediaFiles(files);
    e.target.value = '';
  });

  async function addMediaFiles(files) {
    for (const file of files) {
      if (!file.type.startsWith('video/') && !file.type.startsWith('audio/')) continue;
      const url = URL.createObjectURL(file);
      state.objectUrls.set(file.name + file.lastModified, url);
      state.files.push({ file, url, kind: file.type.startsWith('audio/') ? 'audio' : 'video' });
    }
    renderPlaylist();
    if (state.currentIndex < 0 && state.files.length) await selectMedia(0, false);
    updateAll();
  }

  function removeMedia(index) {
    if (index < 0 || index >= state.files.length) return;
    const item = state.files[index];
    URL.revokeObjectURL(item.url);
    state.files.splice(index,1);
    if (!state.files.length) {
      media.pause(); media.removeAttribute('src'); media.load(); state.currentIndex = -1;
    } else if (index === state.currentIndex) {
      const next = Math.min(index, state.files.length - 1);
      state.currentIndex = -1; selectMedia(next, false);
    } else if (index < state.currentIndex) state.currentIndex -= 1;
    renderPlaylist(); updateAll();
  }

  $('clearListBtn').addEventListener('click', () => {
    media.pause(); state.files.forEach(x => URL.revokeObjectURL(x.url)); state.files=[]; state.currentIndex=-1; media.removeAttribute('src'); media.load();
    updateAll(); renderPlaylist(); setStatus('列表已清空');
  });

  async function selectMedia(index, autoPlay = true) {
    if (index < 0 || index >= state.files.length) return;
    const item = state.files[index];
    state.currentIndex = index;
    state.subtitleIndex = findSubtitleIndex(media.currentTime || 0);
    state.subtitleVersion++;
    subtitleLayer.textContent = '';
    state.subtitleLock = false;
    media.classList.remove('audio-mode');
    emptyState.style.display = 'none';
    audioPoster.classList.toggle('active', item.kind === 'audio');
    setStatus(`载入：${item.file.name}`);
    media.src = item.url;
    media.load();
    try { media.playbackRate = state.rate; media.volume = state.volume; } catch {}
    await waitForMetadata();
    try { media.playbackRate = state.rate; media.volume = state.volume; } catch {}
    updateAll(); renderPlaylist();
    if (autoPlay) await safePlay();
  }

  function waitForMetadata() {
    return new Promise(resolve => {
      if (Number.isFinite(media.duration) && media.duration > 0) return resolve();
      const done = () => { cleanup(); resolve(); };
      const cleanup=()=>{media.removeEventListener('loadedmetadata',done);media.removeEventListener('error',done);};
      media.addEventListener('loadedmetadata',done,{once:true}); media.addEventListener('error',done,{once:true});
    });
  }

  const originalSelect = selectMedia;

  function renderPlaylist() {
    playlistEl.innerHTML = '';
    if (!state.files.length) { playlistEl.innerHTML = '<div class="muted">暂无媒体文件</div>'; return; }
    state.files.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'playlist-item' + (i===state.currentIndex ? ' active' : '');
      row.innerHTML = `<div class="item-index">${i+1}</div><div><div class="item-name"></div><div class="item-meta">${item.kind === 'audio' ? '音频' : '视频'}</div></div><button class="remove-item" title="移除">×</button>`;
      row.querySelector('.item-name').textContent = item.file.name;
      row.addEventListener('click', (e) => { if (e.target.closest('.remove-item')) return; selectMedia(i, true); });
      row.querySelector('.remove-item').addEventListener('click', e => { e.stopPropagation(); removeMedia(i); });
      playlistEl.appendChild(row);
    });
  }

  $('warmupBtn').addEventListener('click', async () => {
    grantPlayback(135, '预热 2:15');
    await safePlay();
  });

  async function safePlay() {
    if (state.currentIndex < 0) return;
    if (state.grantRemaining <= 0 && state.warmupEndsAt <= Date.now()) {
      setStatus('没有可用播放时间，请计步或点击预热');
      return;
    }
    try {
      await media.play();
    } catch (err) { setStatus('浏览器阻止自动播放，请手动点击播放'); }
  }

  $('playBtn').addEventListener('click', async () => {
    if (media.paused) await safePlay(); else media.pause();
  });
  $('muteBtn').addEventListener('click', () => {
    media.muted = !media.muted;
    $('muteBtn').textContent = media.muted ? '🔇' : '🔊';
  });
  $('fullscreenBtn').addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await playerStage.requestFullscreen();
      else await document.exitFullscreen();
    } catch { setStatus('当前浏览器不允许全屏'); }
  });
  document.addEventListener('fullscreenchange', () => {
    playerStage.classList.toggle('fullscreen', !!document.fullscreenElement);
  });

  let seeking = false;
  const progress = $('progress'); const fsProgress = $('fullscreenProgress');
  function handleSeek(v) {
    if (!Number.isFinite(media.duration) || media.duration <= 0) return;
    media.currentTime = (Number(v)/1000)*media.duration;
    subtitleLayer.textContent = '';
    state.subtitleIndex = findSubtitleIndex(media.currentTime);
    state.subtitleLock = false;
    state.subtitleVersion++;
  }
  progress.addEventListener('input', e => { seeking = true; handleSeek(e.target.value); updateProgressUI(); });
  progress.addEventListener('change', () => { seeking = false; });
  fsProgress.addEventListener('input', e => { seeking = true; handleSeek(e.target.value); updateProgressUI(); });
  fsProgress.addEventListener('change', () => { seeking = false; });

  media.addEventListener('loadedmetadata', () => {
    media.playbackRate = state.rate; media.volume = state.volume;
    updateAll();
  });
  media.addEventListener('play', () => {
    if (state.grantRemaining <= 0 && state.warmupEndsAt <= Date.now()) { media.pause(); return; }
    playerStage.classList.remove('paused'); setStatus('播放中');
  });
  media.addEventListener('pause', () => { playerStage.classList.add('paused'); });
  media.addEventListener('timeupdate', () => { updateProgressUI(); processSubtitleCue(); });
  media.addEventListener('ratechange', () => {
    if (Math.abs(media.playbackRate - state.rate) > .001) { media.playbackRate = state.rate; }
  });
  media.addEventListener('ended', () => { handleEnded(); });

  async function handleEnded() {
    if (state.pendingStep && state.grantRemaining <= 0) {
      state.pendingStep = false; grantPlayback(state.stepGrant, '结算触发');
    }
    if (!state.files.length) return;
    let next;
    if (state.shuffle && state.files.length > 1) {
      const choices = state.files.map((_,i)=>i).filter(i=>i!==state.currentIndex);
      next = choices[Math.floor(Math.random()*choices.length)];
    } else next = (state.currentIndex + 1) % state.files.length;
    await selectMedia(next, true);
  }

  function updateProgressUI() {
    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    const ratio = duration > 0 ? media.currentTime / duration : 0;
    if (!seeking) {
      progress.value = Math.round(ratio * 1000);
      fsProgress.value = Math.round(ratio * 1000);
    }
    $('progressFill').style.width = `${ratio*100}%`;
    $('fullscreenProgressFill').style.width = `${ratio*100}%`;
    bodyProgress.firstElementChild.style.width = `${ratio*100}%`;
    $('currentTime').textContent = fmtTime(media.currentTime);
    $('duration').textContent = fmtTime(duration);
  }

  function updateAll() {
    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    $('grantDisplay').textContent = fmtTime(state.grantRemaining);
    $('pendingDisplay').textContent = state.pendingStep ? '1' : '0';
    $('mediaIndexDisplay').textContent = state.files.length ? `${Math.max(1,state.currentIndex+1)} / ${state.files.length}` : '0 / 0';
    $('resourceName').textContent = state.currentIndex >=0 ? state.files[state.currentIndex].file.name : '未选择';
    $('subtitleStatus').textContent = state.subtitles.length ? `${state.subtitleFileName} · ${state.subtitles.length} 段` : '未加载';
    $('musicStatus').textContent = state.musicName || '未加载';
    $('segmentStatus').textContent = state.subtitles.length ? (state.subtitleLock ? '字幕 TTS 中' : '字幕同步') : '普通模式';
    $('beatStateDisplay').textContent = state.music ? '运行中' : '关闭';
    progress.max = fsProgress.max = 1000;
    if (duration) updateProgressUI();
  }

  // ---------- Step detection ----------
  $('sensorBtn').addEventListener('click', async () => {
    if (state.stepSensorOn) { state.stepSensorOn = false; $('sensorBtn').textContent = '开启计步'; setStatus('计步已停止'); return; }
    const ok = await enableStepSensor();
    if (ok) { state.stepSensorOn = true; $('sensorBtn').textContent = '停止计步'; setStatus('计步检测已开启'); }
  });

  async function enableStepSensor() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        const p = await DeviceMotionEvent.requestPermission();
        if (p !== 'granted') throw new Error('motion permission denied');
      }
      if ('Accelerometer' in window) {
        const sensor = new Accelerometer({frequency: 30, referenceFrame: 'device'});
        sensor.addEventListener('reading', () => handleMotion(sensor.x, sensor.y, sensor.z));
        sensor.addEventListener('error', () => attachMotionEvent());
        sensor.start();
        state.motionSensor = sensor;
      } else {
        attachMotionEvent();
      }
      return true;
    } catch {
      setStatus('未能取得传感器权限，可继续用预热按钮测试');
      return false;
    }
  }
  function attachMotionEvent() {
    window.addEventListener('devicemotion', e => {
      const a = e.accelerationIncludingGravity || e.acceleration;
      if (a) handleMotion(a.x||0,a.y||0,a.z||0);
    });
  }
  function handleMotion(x,y,z) {
    if (!state.stepSensorOn) return;
    const mag = Math.sqrt(x*x+y*y+z*z);
    const d = state.stepDetector;
    d.baseline = d.baseline*0.92 + mag*0.08;
    const high = mag - d.baseline > 1.8;
    const now = performance.now();
    if (high && !d.peak && now - d.lastPeakAt > 280) {
      d.peak = true; d.lastPeakAt = now; onStepDetected();
    } else if (!high) d.peak = false;
  }
  function onStepDetected() {
    spawnHeart();
    if (state.grantRemaining > 0) {
      if (state.grantRemaining <= state.settleWindow) state.pendingStep = true;
      updateAll();
      return;
    }
    grantPlayback(state.stepGrant, '计步触发');
  }
  function grantPlayback(seconds, reason) {
    state.grantRemaining = Math.max(0, Number(seconds)||0);
    state.pendingStep = false;
    state.warmupEndsAt = Date.now() + state.grantRemaining*1000;
    setStatus(reason);
    updateAll();
  }
  setInterval(() => {
    if (state.grantRemaining > 0) {
      state.grantRemaining = Math.max(0, state.warmupEndsAt ? (state.warmupEndsAt-Date.now())/1000 : state.grantRemaining-0.1);
      if (state.grantRemaining <= 0) {
        state.grantRemaining = 0; state.warmupEndsAt = 0;
        media.pause();
        if (state.pendingStep) { state.pendingStep = false; grantPlayback(state.stepGrant,'结算触发'); safePlay(); }
        else setStatus('播放时间已结束');
      }
      updateAll();
    }
  }, 100);

  function spawnHeart() {
    if (!document.fullscreenElement) return;
    const h = document.createElement('div'); h.className='heart'; h.textContent='♥';
    h.style.left = `${10 + Math.random()*80}%`; h.style.top = `${55 + Math.random()*28}%`;
    h.style.setProperty('--dx', `${-50+Math.random()*100}px`); h.style.setProperty('--rot', `${-20+Math.random()*40}deg`);
    $('heartLayer').appendChild(h); setTimeout(()=>h.remove(),1750);
    try { navigator.vibrate?.(35); } catch {}
  }

  // ---------- Subtitles ----------
  $('subtitleInput').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      state.subtitles = parseSubtitle(text, file.name);
      state.subtitleFileName = file.name;
      state.subtitleIndex = findSubtitleIndex(media.currentTime);
      state.subtitleVersion++;
      subtitleLayer.textContent = '';
      setStatus(`字幕已加载：${file.name}`); updateAll();
    } catch (err) {
      state.subtitles=[]; state.subtitleFileName=''; updateAll(); setStatus('字幕解析失败');
    }
    e.target.value='';
  });
  $('clearSubtitleBtn').addEventListener('click', () => { state.subtitles=[]; state.subtitleFileName=''; state.subtitleIndex=0; state.subtitleLock=false; speechSynthesis.cancel(); subtitleLayer.textContent=''; setStatus('字幕功能已解除'); updateAll(); });

  function parseSubtitle(text, name) {
    const ext = name.toLowerCase().split('.').pop();
    let cues=[];
    if (ext==='json') {
      const arr=JSON.parse(text); if(!Array.isArray(arr)) throw new Error('json not array');
      cues=arr.map(x=>({from:Number(x.from),to:Number(x.to),content:String(x.content??'')}));
    } else if (ext==='lrc') {
      cues=text.split(/\r?\n/).flatMap(line=>{
        const ms=[...line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:\.(\d{1,3}))?\]/g)];
        const content=line.replace(/(?:\[[^\]]+\])+\s*/,'').trim();
        return ms.map(m=>({from:Number(m[1])*60+Number(m[2])+(Number((m[3]||'0').padEnd(3,'0'))/1000),to:null,content}));
      });
      cues.forEach((c,i)=>c.to = cues[i+1]?.from ?? c.from+4);
    } else {
      const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/); let i=0;
      while(i<lines.length){
        let line=lines[i].trim();
        if(/^WEBVTT/i.test(line)||!line){i++;continue;}
        if(/^\d+$/.test(line)){i++; line=(lines[i]||'').trim();}
        const m=line.match(/^(.+?)\s+-->\s+(.+?)(?:\s+.*)?$/);
        if(m){
          const from=timecode(m[1]); const to=timecode(m[2]);
          i++; const parts=[]; while(i<lines.length && lines[i].trim()!==''){parts.push(lines[i].trim());i++;}
          cues.push({from,to,content:parts.join(' ')});
        } else i++;
      }
    }
    cues=cues.filter(c=>Number.isFinite(c.from)&&Number.isFinite(c.to)&&c.to>c.from&&c.content).sort((a,b)=>a.from-b.from);
    return cues;
  }
  function timecode(s){
    const p=s.trim().replace(',', '.').split(':').map(Number);
    if(p.length===3)return p[0]*3600+p[1]*60+p[2];
    if(p.length===2)return p[0]*60+p[1];
    return Number(p[0]);
  }
  function findSubtitleIndex(t){
    if(!state.subtitles.length)return 0;
    let lo=0,hi=state.subtitles.length-1,ans=0;
    while(lo<=hi){const mid=(lo+hi)>>1;if(state.subtitles[mid].from<=t){ans=mid;lo=mid+1}else hi=mid-1;}
    return Math.max(0,ans);
  }
  function processSubtitleCue(){
    if(!state.subtitles.length || state.subtitleLock || media.seeking) { return; }
    const cue=state.subtitles[state.subtitleIndex]; if(!cue) return;
    if(media.currentTime + 0.04 < cue.from) return;
    if(media.currentTime > cue.to + 0.05){
      state.subtitleIndex = Math.min(state.subtitleIndex+1,state.subtitles.length-1); return;
    }
    state.subtitleLock = true; state.pausedBySubtitle=true; media.pause();
    const version=++state.subtitleVersion;
    media.currentTime=cue.from;
    subtitleLayer.textContent=cue.content;
    setStatus('TTS 朗读中');
    const utter=new SpeechSynthesisUtterance(cue.content); utter.lang='zh-CN'; utter.rate=1;
    const finish=()=>{
      if(version!==state.subtitleVersion)return;
      subtitleLayer.textContent=cue.content;
      media.currentTime=cue.from;
      safePlay().then(()=>{setStatus('字幕片段播放');});
    };
    utter.onend=finish; utter.onerror=finish;
    try{speechSynthesis.cancel();speechSynthesis.speak(utter);}catch{finish();}
    waitUntilSegmentEnds(cue,version);
  }
  function waitUntilSegmentEnds(cue,version){
    const tick=()=>{
      if(version!==state.subtitleVersion)return;
      if(!state.subtitleLock)return;
      if(media.currentTime >= cue.to - 0.03){
        media.pause(); state.subtitleLock=false; state.pausedBySubtitle=false;
        state.subtitleIndex += 1;
        subtitleLayer.textContent='';
        setStatus('等待下一段字幕');
        // resume immediately in normal regions, while next cue will be intercepted at its from time
        safePlay();
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------- Music / beat detection ----------
  $('musicInput').addEventListener('change', async e=>{
    const file=e.target.files?.[0]; if(!file)return;
    await loadMusic(file); e.target.value='';
  });
  async function loadMusic(file){
    removeMusic(false);
    state.musicUrl=URL.createObjectURL(file); state.musicName=file.name;
    const audio=document.createElement('audio'); audio.src=state.musicUrl; audio.loop=true; audio.preload='auto'; audio.playsInline=true;
    state.music=audio;
    try{
      state.audioCtx = new (window.AudioContext||window.webkitAudioContext)();
      state.analyser=state.audioCtx.createAnalyser(); state.analyser.fftSize=1024; state.analyser.smoothingTimeConstant=.6;
      const src=state.audioCtx.createMediaElementSource(audio); state.musicGain=state.audioCtx.createGain(); state.musicGain.gain.value=state.musicVolume;
      src.connect(state.analyser); state.analyser.connect(state.musicGain); state.musicGain.connect(state.audioCtx.destination);
      await state.audioCtx.resume(); await audio.play();
      startBeatLoop(); setStatus(`音乐律动：${file.name}`); updateAll();
    }catch(err){setStatus('音乐分析初始化失败'); removeMusic(false);}
  }
  function removeMusic(update=true){
    cancelAnimationFrame(state.beatRAF); state.beatRAF=0;
    if(state.music){state.music.pause();state.music.src='';}
    if(state.musicUrl){URL.revokeObjectURL(state.musicUrl);state.musicUrl='';}
    try{state.audioCtx?.close();}catch{}
    state.music=null;state.musicName='';state.audioCtx=null;state.analyser=null;state.musicGain=null;
    if(update) {setStatus('音乐律动已解除');updateAll();}
  }
  $('clearMusicBtn').addEventListener('click',()=>removeMusic(true));

  function startBeatLoop(){
    const analyser=state.analyser; if(!analyser)return;
    const data=new Uint8Array(analyser.frequencyBinCount);
    const tick=(now)=>{
      analyser.getByteFrequencyData(data);
      let sum=0, count=0; for(let i=0;i<data.length;i++){const f=i/(data.length); if(f>.03&&f<.75){sum+=data[i];count++;}}
      const energy=(sum/Math.max(1,count))/255;
      const flux=Math.max(0,energy-state.prevEnergy); state.prevEnergy=energy;
      state.peakHistory.push(flux); if(state.peakHistory.length>24)state.peakHistory.shift();
      const avg=state.peakHistory.reduce((a,b)=>a+b,0)/Math.max(1,state.peakHistory.length);
      const adaptive=state.beatThreshold * .35 + avg*.65;
      if(flux>Math.max(.025,adaptive) && now-state.lastBeatAt>state.jumpCooldown*1000){
        state.lastBeatAt=now; triggerRhythmJump();
      }
      state.beatRAF=requestAnimationFrame(tick);
    };
    cancelAnimationFrame(state.beatRAF); state.beatRAF=requestAnimationFrame(tick);
  }
  async function triggerRhythmJump(){
    if(state.currentIndex<0 || !Number.isFinite(media.duration) || media.duration<=1)return;
    if(Date.now()-state.lastJumpAt<state.jumpCooldown*1000)return;
    const pick=pickJumpTarget(); if(!pick)return;
    state.lastJumpAt=Date.now();
    try {
      if(pick.index!==state.currentIndex){
        await originalSelect(pick.index,false);
        const target=pickRandomTimeForMedia(media.duration);
        if(target==null) return;
        media.currentTime=target;
        await safePlay();
      } else {
        media.currentTime=pick.time;
        await safePlay();
      }
    } finally {
      const flash=$('jumpFlash'); flash.classList.remove('active'); void flash.offsetWidth; flash.classList.add('active');
      if(document.fullscreenElement){try{navigator.vibrate?.(50);}catch{}}
      setStatus('音乐节拍跳跃');
    }
  }
  function pickRandomTimeForMedia(dur){
    const min=state.avoidStart*60; const max=dur-state.avoidEnd*60;
    if(max<=min+1)return null;
    return min+Math.random()*(max-min-0.05);
  }
  function pickJumpTarget(){
    const eligible=state.files.map((item,index)=>({item,index})).filter(x=>x.item);
    if(!eligible.length)return null;
    const pick=eligible[Math.floor(Math.random()*eligible.length)];
    if(pick.index!==state.currentIndex) return {index:pick.index,time:0};
    const dur=media.duration; const min=state.avoidStart*60; const max=dur-state.avoidEnd*60;
    if(max<=min+1)return null;
    const cur=media.currentTime; const span=Math.max(1,max-min);
    let t=min+Math.random()*span;
    if(span>20 && Math.random()<.65){
      const delta=(Math.random()*.6+.15)*span;
      t=Math.random()<.5?cur-delta:cur+delta;
    }
    t=Math.max(min,Math.min(max-.05,t));
    return {index:pick.index,time:t};
  }

  // drag & drop media files
  document.addEventListener('dragover', e=>{if(e.dataTransfer?.types?.includes('Files'))e.preventDefault();});
  document.addEventListener('drop', e=>{if(!e.dataTransfer?.files?.length)return;e.preventDefault();addMediaFiles([...e.dataTransfer.files]);});

  // keyboard speed adjustment; media seeking stays untouched.
  document.addEventListener('keydown', e=>{
    if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
    if(e.key==='['){state.rate=clamp(state.rate-.05,.25,4,state.rate);rateCtrl.apply(state.rate);}
    if(e.key===']'){state.rate=clamp(state.rate+.05,.25,4,state.rate);rateCtrl.apply(state.rate);}
    if(e.key===' '){e.preventDefault();$('playBtn').click();}
  });

  // keep the global rate across any source switch, even when the browser resets its media state.
  setInterval(()=>{
    if(state.currentIndex>=0 && Math.abs(media.playbackRate-state.rate)>.001) media.playbackRate=state.rate;
  },500);

  // Initial render.
  renderPlaylist(); updateAll();
})();
