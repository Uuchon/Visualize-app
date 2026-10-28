// WAVE LAB - 安定化済み 完全版スケッチ (p5 2.3.4 + p5.sound 0.4.1 前提)
// - AnalyserNode.fftSize の監視と自動補正
// - createSafeFFT / ensureFFTReady
// - userStartAudio 互換ラッパーで遅延初期化
// - safeSetFFTInput / safeMasterGainAmp による保護
// - ISO226簡易補正を用いた perceived loudness の適用

class SafeFFT {
  constructor(smoothing = 0.8, fftSize = 2048) {
    const context = typeof getAudioContext === 'function' ? getAudioContext() : null;
    if (!context) throw new Error('Web Audio AudioContext が利用できません');

    this.analyser = context.createAnalyser();

    // Web Audio requires a power of two from 32 through 32768.
    const allowedSizes = [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
    const safeSize = allowedSizes.includes(fftSize) ? fftSize : 2048;

    this.analyser.fftSize = safeSize;
    this.analyser.smoothingTimeConstant = constrain(smoothing, 0, 1);

    this._data = new Uint8Array(this.analyser.frequencyBinCount);
    this._sourceNode = null;
  }

  setInput(source) {
    if (this._sourceNode) {
      try {
        this._sourceNode.disconnect(this.analyser);
      } catch (err) {}
      this._sourceNode = null;
    }

    if (!source) return;

    // p5 sound objects expose their Web Audio node as .output; accept a raw
    // AudioNode as well for compatibility with different p5.sound versions.
    const node =
      source.output && typeof source.output.connect === 'function'
        ? source.output
        : source.input && typeof source.input.connect === 'function'
          ? source.input
          : source;

    if (!node || typeof node.connect !== 'function') {
      throw new Error('FFT入力からAudioNodeを取得できませんでした');
    }

    node.connect(this.analyser);
    this._sourceNode = node;
  }

  analyze() {
    this.analyser.getByteFrequencyData(this._data);
    return Array.from(this._data);
  }
}

function createSafeFFT(smoothing = 0.8, desiredBins = 512) {
  // bins are half the Web Audio fftSize; 512 bins -> fftSize 1024.
  const waveLabBinCount = Math.max(16, Math.min(1024, Math.floor(desiredBins)));
  const waveLabPowerOfTwoBins = Math.pow(2, Math.round(Math.log2(waveLabBinCount)));
  return new SafeFFT(smoothing, waveLabPowerOfTwoBins * 2);
}

let fft = null;
let fftBins = 512;

function ensureFFTReady() {
  if (!fft) fft = createSafeFFT(0.8, fftBins);
}

async function ensureUserAudioStarted() {
  if (typeof userStartAudio === 'function') {
    await userStartAudio();
    return;
  }

  if (typeof getAudioContext === 'function') {
    const ac = getAudioContext();
    if (ac && ac.state === 'suspended') await ac.resume();
  }
}

function safeSetFFTInput(source) {
  ensureFFTReady();
  if (!fft) return;
  if (!source) {
    try {
      if (fft._sourceNode) fft._sourceNode.disconnect(fft.analyser);
    } catch (err) {}
    fft._sourceNode = null;
    return;
  }
  fft.setInput(source);
}

function setOutputVolume(value) {
  const volume = constrain(Number(value), 0, 1);
  if (typeof masterVolume === 'function') masterVolume(volume, 0.05);
}

// ================= 1) グローバル状態と解析変数 =================
let audioProcessor;
let frequencyMapper;
let harmonicAnalyzer;

let dominantFreq = 0;
let dominantAmplitude = 0;
let perceivedLoudness = 0;
let circleRadius = 50;
let currentColor = { r: 255, g: 0, b: 0 };
let harmonicRatio = 0.5;
let spectrumData = [];

let spectralCentroid = 0;
let spectralSpread = 0;

let micActive = false;
let noiseActive = false;

let isCalibrating = false;
let calibrationStartTime = 0;
let calibrationDuration = 3000;

let tempCollectedFreqs = [];
let tempCollectedSpectraSum = [];
let calibrationFramesCount = 0;
let noiseProfile = null;

let micButton, noiseButton, testButton, clearNoiseButton;
let masterVolSlider;
let colorHistory = [];
const TH = { ink: '#2b3a55', sub: '#6b7a99', dark: '#14233b', accent: '#17b8a6' };
const UI_FONT = '"M PLUS Rounded 1c","Hiragino Maru Gothic ProN","Yu Gothic UI",sans-serif';
const UI_TABS = [['home', '🏠', 'ホーム'], ['analysis', '📊', '分析'], ['trail', '🎨', '色の軌跡'], ['settings', '⚙️', 'せってい']];
 
let uiScreen = 'home';
let uiMobile = false;
let uiLayout = {};
let uiHits = [];
let uiSliders = [];
let uiActiveSlider = null;
let uiToastText = '';
let uiToastUntil = 0;
let uiVolume = 0.6;
let uiBlobR = 40;
let trailG = null;
let trailAngle = 0;
let trailFade = false;
let trailTouched = false;
 
// ================= p5 本体 =================
function setup() {
  createCanvas(windowWidth, windowHeight);
  textFont(UI_FONT);
  ensureFFTReady();
  audioProcessor = new AudioProcessor();
  frequencyMapper = new FrequencyMapper();
  harmonicAnalyzer = new HarmonicAnalyzer();
}
 
function draw() {
  uiHits = [];
  uiSliders = [];
  uiMobile = width < 720;
 
  if (noiseActive) {
    audioProcessor.setFreq(map(sin(frameCount * 0.03), -1, 1, frequencyMapper.minFreq, frequencyMapper.maxFreq));
  }
  spectrumData = (fft && fft.analyser) ? fft.analyze() : [];
  analyzeFrequencyContent();
  handleCalibration();
  pushColorHistory();
 
  uiComputeLayout();
  uiBackground();
  uiNav();
  uiHeader();
 
  const c = uiLayout.content;
  if (uiScreen === 'home') uiHome(c);
  else if (uiScreen === 'analysis') uiAnalysis(c);
  else if (uiScreen === 'trail') uiTrail(c);
  else uiSettings(c);
 
  uiDrawToast();
}
 
// ================= 2) 等ラウドネス簡易補正（ISO226 風） =================


// ================= 4) 音声解析（ガード付き） =================
function analyzeFrequencyContent() {
  if (!spectrumData || spectrumData.length === 0) {
    dominantFreq = 0;
    dominantAmplitude = 0;
    spectralCentroid = 0;
    spectralSpread = 0;
    perceivedLoudness = 0;
    harmonicRatio = 0.5;
    currentColor = { r: 230, g: 235, b: 240 };
    return;
  }

  let totalAmp = 0;
  let weightedFreq = 0;
  let maxAmplitude = 0;
  let maxFreqIndex = 0;
  const nyquist = typeof sampleRate === 'function' ? sampleRate() / 2 : 22050;

  for (let i = 1; i < spectrumData.length; i++) {
    const amp = spectrumData[i];
    if (amp > maxAmplitude) {
      maxAmplitude = amp;
      maxFreqIndex = i;
    }
  }

  dominantAmplitude = maxAmplitude / 255;
  dominantFreq = (maxFreqIndex * nyquist) / spectrumData.length;
  perceivedLoudness = getLoudnessPerceived(dominantFreq, dominantAmplitude);

  for (let i = 1; i < spectrumData.length; i++) {
    const amp = spectrumData[i];
    if (amp < 5) continue;
    const freq = (i * nyquist) / spectrumData.length;
    if (freq < 20 || freq > 20000) continue;
    weightedFreq += freq * amp;
    totalAmp += amp;
  }

  spectralCentroid = totalAmp > 0 ? weightedFreq / totalAmp : 0;

  let variance = 0;
  for (let i = 1; i < spectrumData.length; i++) {
    const amp = spectrumData[i];
    if (amp < 5) continue;
    const freq = (i * nyquist) / spectrumData.length;
    if (freq < 20 || freq > 20000) continue;
    variance += amp * Math.pow(freq - spectralCentroid, 2);
  }
  spectralSpread = totalAmp > 0 ? Math.sqrt(variance / totalAmp) : 0;

  harmonicRatio = harmonicAnalyzer.analyzeHarmonics(spectrumData, dominantFreq);
  currentColor = calculateCentroidColor();
}

function calculateCentroidColor() {
  if (dominantAmplitude < 0.02 || spectralCentroid === 0) {
    return { r: 230, g: 235, b: 240 };
  }

  let nm = frequencyMapper.frequencyToNanometers(spectralCentroid);
  let hueValue = map(nm, 780, 380, 0, 270, true);
  let spreadLog = Math.log(spectralSpread + 1);
  let sat = map(spreadLog, 0, 9, 100, 20, true);
  let bri = map(perceivedLoudness, 0.02, 1.0, 30, 100, true);

  colorMode(HSB, 360, 100, 100);
  let c = color(hueValue, sat, bri);
  let result = { r: red(c), g: green(c), b: blue(c) };
  colorMode(RGB, 255);

  return result;
}

// ================= 5) キャリブレーション =================

function handleCalibration() {
  if (!isCalibrating) return;

  let elapsed = millis() - calibrationStartTime;
  let progress = Math.min(100, Math.floor((elapsed / calibrationDuration) * 100));

  if (testButton) {
    testButton.html(`⏳ 計測中 ${progress}%`);
    testButton.style('background-color', '#ff9f43');
  }

  if (elapsed < calibrationDuration) {
    if (spectrumData && spectrumData.length > 0 && dominantAmplitude > 0.01) {
      if (tempCollectedSpectraSum.length !== spectrumData.length) {
        tempCollectedSpectraSum = new Array(spectrumData.length).fill(0);
      }
      for (let i = 0; i < spectrumData.length; i++) {
        tempCollectedSpectraSum[i] += spectrumData[i];
      }
      calibrationFramesCount++;
      if (spectralCentroid > 0) tempCollectedFreqs.push(spectralCentroid);
    }
  } else {
    isCalibrating = false;

    if (testButton) {
      testButton.html('⏱️ 3秒環境テスト');
      testButton.style('background-color', '#10ac84');
    }

    if (calibrationFramesCount > 3 && tempCollectedFreqs.length > 5) {
      noiseProfile = tempCollectedSpectraSum.map(v => v / calibrationFramesCount);
      noiseProfile = smoothArray(noiseProfile, 3);

      let detectedMin = Math.min(...tempCollectedFreqs);
      let detectedMax = Math.max(...tempCollectedFreqs);

      if (detectedMax - detectedMin < 200) {
        detectedMin = Math.max(20, detectedMin - 100);
        detectedMax = Math.min(20000, detectedMax + 100);
      }

      frequencyMapper.updateRange(detectedMin, detectedMax);
    } else {
      alert('十分な音量が検知できませんでした。声を出しながらもう一度お試しください。');
    }
  }
}

function smoothArray(arr, windowSize) {
  const out = new Array(arr.length);
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < arr.length) {
        sum += arr[j];
        cnt++;
      }
    }
    out[i] = cnt > 0 ? sum / cnt : arr[i];
  }
  return out;
}

// ================= 6) UI / 描画ヘルパー =================
function pushColorHistory() {
  colorHistory.push(currentColor);
  if (colorHistory.length > width) colorHistory.shift();
}

function drawColorHistoryTimeline() {
  const timelineHeight = 40;
  const timelineY = height - timelineHeight;
  noStroke();

  for (let i = 0; i < colorHistory.length; i++) {
    const x = map(i, 0, colorHistory.length, 0, width);
    const w = width / colorHistory.length + 1;
    const col = colorHistory[i];
    fill(col.r, col.g, col.b);
    rect(x, timelineY, w, timelineHeight);
  }

  stroke(200);
  strokeWeight(1);
  line(0, timelineY, width, timelineY);

  fill(100);
  noStroke();
  textSize(11);
  textAlign(LEFT, BOTTOM);
  text('⏱️ 音色の時系列ヒストリー（右端が現在）', 20, timelineY - 6);
}

function updateCircleProperties() {
  const targetRadius = 60 + perceivedLoudness * 250;
  circleRadius = lerp(circleRadius, targetRadius, 0.15);
}

function drawDynamicCircle() {
  const segments = 128;
  const baseRadius = circleRadius;
  const deformation = (1 - harmonicRatio) * 0.4;

  noStroke();
  fill(currentColor.r, currentColor.g, currentColor.b, 220);
  beginShape();
  for (let i = 0; i < segments; i++) {
    const angle = TWO_PI * i / segments;
    const noiseAmount = deformation * sin(angle * 5 + frameCount * 0.05) * baseRadius * perceivedLoudness;
    const r = baseRadius + noiseAmount;
    vertex(r * cos(angle), r * sin(angle));
  }
  endShape(CLOSE);

  stroke(currentColor.r, currentColor.g, currentColor.b);
  strokeWeight(3);
  noFill();
  beginShape();
  for (let i = 0; i < segments; i++) {
    const angle = TWO_PI * i / segments;
    const noiseAmount = deformation * sin(angle * 5 + frameCount * 0.05) * baseRadius * perceivedLoudness;
    const r = baseRadius + noiseAmount;
    vertex(r * cos(angle), r * sin(angle));
  }
  endShape(CLOSE);
}

function drawStatusPanel() {
  fill(40);
  noStroke();
  textSize(13);
  textAlign(LEFT, TOP);

  let statusText = '待機中';
  if (isCalibrating) statusText = '⚠️ 3秒間音域計測中...';
  else if (micActive) statusText = 'マイク入力中';
  else if (noiseActive) statusText = 'スイープテスト音生成中';

  const nmValue = frequencyMapper.frequencyToNanometers(spectralCentroid);

  text(`状態: ${statusText}`, 20, 80);
  text(`主要周波数: ${dominantFreq.toFixed(0)} Hz`, 20, 105);
  text(`スペクトル重心: ${spectralCentroid.toFixed(0)} Hz`, 20, 130);
  text(`耳の感度補正音量: ${(perceivedLoudness * 100).toFixed(0)} %`, 20, 155);
  text(`推定波長: ${spectralCentroid > 0 ? nmValue.toFixed(0) : '0'} nm`, 20, 180);

  fill(10, 120, 200);
  text(`適合音域: ${frequencyMapper.minFreq.toFixed(0)} Hz 〜 ${frequencyMapper.maxFreq.toFixed(0)} Hz`, 20, 205);

  fill(80);
  noStroke();
  textSize(12);
  textAlign(LEFT, TOP);
  text(`ノイズ除去: ${noiseProfile ? 'ON' : 'OFF'}`, 20, 230);
}

function drawSpectrumBar() {
  const barX = 20;
  const barY = height - 110;
  const barWidth = min(width - 40, 700);
  const barHeight = 25;

  colorMode(HSB, 360, 100, 100);
  for (let i = 0; i < barWidth; i++) {
    const hueVal = map(i, 0, barWidth, 0, 270);
    stroke(hueVal, 90, 90);
    line(barX + i, barY, barX + i, barY + barHeight);
  }

  colorMode(RGB, 255);
  noFill();
  stroke(180);
  rect(barX, barY, barWidth, barHeight, 4);

  if (spectralCentroid > 0 && dominantAmplitude > 0.02) {
    const currentNm = frequencyMapper.frequencyToNanometers(spectralCentroid);
    const markerX = map(currentNm, 780, 380, barX, barX + barWidth);
    fill(30);
    noStroke();
    triangle(markerX, barY - 2, markerX - 6, barY - 10, markerX + 6, barY - 10);
  }

  fill(80);
  noStroke();
  textSize(11);
  textAlign(LEFT, TOP);
  text(`低音 赤 (${frequencyMapper.minFreq.toFixed(0)}Hz)`, barX, barY + barHeight + 5);
  textAlign(RIGHT, TOP);
  text(`高音 紫 (${frequencyMapper.maxFreq.toFixed(0)}Hz)`, barX + barWidth, barY + barHeight + 5);
}

function drawFrequencyGraph() {
  const panelWidth = 280;
  const panelHeight = 120;
  const panelX = width - panelWidth - 20;
  const panelY = height - panelHeight - 110;

  fill(245, 247, 250, 220);
  stroke(220);
  strokeWeight(1);
  rect(panelX, panelY, panelWidth, panelHeight, 8);

  noFill();
  stroke(currentColor.r, currentColor.g, currentColor.b);
  strokeWeight(2);

  beginShape();
  for (let i = 0; i < spectrumData.length; i++) {
    const x = map(i, 0, spectrumData.length, panelX + 10, panelX + panelWidth - 10);
    const y = map(spectrumData[i], 0, 255, panelY + panelHeight - 10, panelY + 10);
    vertex(x, y);
  }
  endShape();

  fill(100);
  noStroke();
  textSize(11);
  textAlign(LEFT, TOP);
  text('リアルタイムFFTスペクトル', panelX + 10, panelY + 8);
}

function drawInfoText() {
  const panelX = width - 240;
  const panelY = 20;

  fill(40);
  noStroke();
  textSize(14);
  textAlign(LEFT, TOP);
  text('リアルタイム音声・音色可視化', panelX, panelY);

  fill(100);
  textSize(11);
  text(
    '1. 「🎤マイク開始」を押す\n2. 低い音〜高い音を出しながら\n   「⏱️3秒環境テスト」を押す\n3. 周囲の環境に合わせて\n   赤〜紫の色変化が最適化されます\n※ISO 226聴覚感度補正適用済',
    panelX,
    panelY + 25
  );
}

// ================= 7) UI 作成とコールバック =================
function createUIButtons() {
  micButton = createButton('🎤 マイク開始');
  micButton.position(20, 20);
  styleButton(micButton, '#4a69bd');
  micButton.mousePressed(async () => {
    try {
      await ensureUserAudioStarted();
      if (!micActive) {
        if (noiseActive) toggleNoise();
        await audioProcessor.startMicrophone();
        micActive = true;
        micButton.html('🎤 マイク停止');
      } else {
        audioProcessor.stopMicrophone();
        micActive = false;
        micButton.html('🎤 マイク開始');
      }
    } catch (err) {
      console.error('Microphone start failed:', err);
      micActive = false;
      micButton.html('🎤 マイク開始');
      alert('マイクを開始できませんでした。ブラウザのマイク許可とHTTPS/localhostでの実行を確認してください。\n' + (err && err.message ? err.message : err));
    }
  });

  noiseButton = createButton('🔊 スイープ音テスト');
  noiseButton.position(170, 20);
  styleButton(noiseButton, '#4a69bd');
  noiseButton.mousePressed(async () => {
    await ensureUserAudioStarted();
    toggleNoise();
  });

  testButton = createButton('⏱️ 3秒環境テスト');
  testButton.position(320, 20);
  styleButton(testButton, '#10ac84');
  testButton.mousePressed(startCalibration);

  clearNoiseButton = createButton('🧹 ノイズプロファイル削除');
  clearNoiseButton.position(520, 20);
  styleButton(clearNoiseButton, '#778ca3');
  clearNoiseButton.mousePressed(() => {
    noiseProfile = null;
    alert('ノイズプロファイルを削除しました。必要なら再度3秒環境テストを行ってください。');
  });

  createDiv('Master Volume:').position(700, 6);
  masterVolSlider = createSlider(0, 1, 0.6, 0.01);
  masterVolSlider.position(830, 10);
  masterVolSlider.input(() => setOutputVolume(masterVolSlider.value()));
}

function toggleNoise() {
  if (!noiseActive) {
    if (micActive) {
      audioProcessor.stopMicrophone();
      micActive = false;
      micButton.html('🎤 マイク開始');
    }

    audioProcessor.startOscillator();
    noiseActive = true;
    noiseButton.html('🔊 テスト音停止');
  } else {
    audioProcessor.stopOscillator();
    noiseActive = false;
    noiseButton.html('🔊 スイープ音テスト');
  }
}

function styleButton(btn, bgColor) {
  btn.style('background-color', bgColor);
  btn.style('color', 'white');
  btn.style('border', 'none');
  btn.style('padding', '8px 12px');
  btn.style('border-radius', '20px');
  btn.style('cursor', 'pointer');
  btn.style('font-weight', 'bold');
  btn.style('font-size', '12px');
  btn.style('width', '150px');
  btn.style('box-shadow', '0 2px 5px rgba(0,0,0,0.1)');
}


// ================= 8) 音声マッピングクラス =================
class FrequencyMapper {
  constructor() {
    this.minFreq = 20;
    this.maxFreq = 20000;
  }

  updateRange(minF, maxF) {
    this.minFreq = Math.max(20, Math.min(minF, maxF));
    this.maxFreq = Math.min(20000, Math.max(minF, maxF));
    if (this.maxFreq <= this.minFreq) this.maxFreq = Math.min(20000, this.minFreq + 1);
  }

  frequencyToNanometers(freq) {
    const logMin = Math.log10(this.minFreq);
    const logMax = Math.log10(this.maxFreq);
    const logFreq = Math.log10(constrain(freq, this.minFreq, this.maxFreq));
    return 780 - (780 - 380) * ((logFreq - logMin) / (logMax - logMin));
  }
}

class HarmonicAnalyzer {
  analyzeHarmonics(spectrum, fundamentalFreq) {
    if (fundamentalFreq < 20 || fundamentalFreq > 20000) return 0.5;

    let harmonicStrength = 0;
    let totalStrength = 0;
    const nyquist = typeof sampleRate === 'function' ? sampleRate() / 2 : 22050;

    for (let harmonic = 1; harmonic <= 8; harmonic++) {
      const harmonicFreq = fundamentalFreq * harmonic;
      if (harmonicFreq > 20000) break;

      const index = Math.round((harmonicFreq / nyquist) * spectrum.length);
      if (index >= 0 && index < spectrum.length) {
        totalStrength += spectrum[index];
        harmonicStrength += spectrum[index] * (1 - (harmonic - 1) * 0.1);
      }
    }

    return totalStrength > 0 ? constrain(harmonicStrength / totalStrength, 0.1, 1.0) : 0.5;
  }
}

// === AudioProcessor: getUserMedia capture and direct Web Audio FFT routing ===
class AudioProcessor {
  constructor() {
    this.micStream = null;
    this.micSource = null;
    this.micStarted = false;
    this.osc = new p5.Oscillator('sine');
    this.osc.amp(0.2);
    this.oscStarted = false;
  }

  async startMicrophone() {
    await ensureUserAudioStarted();

    if (this.micStarted && this.micStream) {
      safeSetFFTInput(this.micSource);
      return;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('このブラウザまたは実行環境ではマイク取得APIが使えません。HTTPSまたはlocalhostで開いてください。');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    try {
      const context = getAudioContext();
      if (context.state === 'suspended') await context.resume();

      const source = context.createMediaStreamSource(stream);
      safeSetFFTInput(source);

      this.micStream = stream;
      this.micSource = source;
      this.micStarted = true;

      console.log('Microphone stream started and connected to FFT.');
    } catch (err) {
      stream.getTracks().forEach(track => track.stop());
      throw err;
    }
  }

  stopMicrophone() {
    try {
      if (this.micSource) this.micSource.disconnect();
      if (this.micStream) this.micStream.getTracks().forEach(track => track.stop());
    } catch (err) {
      console.warn('Microphone stop error:', err);
    }

    this.micSource = null;
    this.micStream = null;
    this.micStarted = false;
    micActive = false;

    // Release the analyser's reference to the stopped microphone source.
    safeSetFFTInput(null);
  }

  startOscillator() {
    try {
      if (!this.oscStarted) {
        this.osc.start();
        this.oscStarted = true;
      }
      safeSetFFTInput(this.osc);
    } catch (err) {
      console.warn('Oscillator start error:', err);
    }
  }

  stopOscillator() {
    try {
      if (this.oscStarted) this.osc.stop();
    } catch (err) {
      console.warn('Oscillator stop error:', err);
    }

    this.oscStarted = false;
    safeSetFFTInput(null);
  }

  setFreq(freq) {
    try {
      this.osc.freq(freq);
    } catch (err) {
      console.warn('setFreq error:', err);
    }
  }
}

// ============================================================
// loudness_charts.js  - WAVE LAB 追加モジュール
//  1) ISO 226:2003 の正式パラメータによる等ラウドネス曲線
//  2) 「周波数 → 色相 / 音量(phon) → 明度 / 広がり → 彩度」の対応グラフ
//  3) 実時間の getLoudnessPerceived() を ISO226 ベースに統一
// ============================================================

// ---------- ISO 226:2003 パラメータ（20Hz〜12.5kHz, 29点） ----------
const ISO = {
  f: [20,25,31.5,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500],
  af: [0.532,0.506,0.480,0.455,0.432,0.409,0.387,0.367,0.349,0.330,0.315,0.301,0.288,0.276,0.267,0.259,0.253,0.250,0.246,0.244,0.243,0.243,0.243,0.242,0.242,0.245,0.254,0.271,0.301],
  Lu: [-31.6,-27.2,-23.0,-19.1,-15.9,-13.0,-10.3,-8.1,-6.2,-4.5,-3.1,-2.0,-1.1,-0.4,0.0,0.3,0.5,0.0,-2.7,-4.1,-1.0,1.7,2.5,1.2,-2.1,-7.1,-11.2,-10.7,-3.1],
  Tf: [78.5,68.7,59.5,51.1,44.0,37.5,31.5,26.5,22.1,17.9,14.4,11.4,8.6,6.2,4.4,3.0,2.2,2.4,3.5,1.7,-1.3,-4.2,-6.0,-5.4,-1.5,6.0,12.6,13.9,12.3]
};

const PHON_MAX = 90;
let splOffset = 100; // 簡易校正: 0 dBFS を何 dB SPL とみなすか
let showCharts = false;
let splSlider, chartButton;
let heatCache = null;
let heatKey = '';

// ---------- 等ラウドネス計算 ----------
function isoParam(arr, freq) {
  const f = constrain(freq, ISO.f[0], ISO.f[ISO.f.length - 1]);
  let i = 0;
  while (i < ISO.f.length - 2 && f > ISO.f[i + 1]) i++;
  const t = (Math.log(f) - Math.log(ISO.f[i])) / (Math.log(ISO.f[i + 1]) - Math.log(ISO.f[i]));
  return arr[i] + (arr[i + 1] - arr[i]) * t;
}

// 周波数 freq で phon 値 phon に聞こえる音圧レベル (dB SPL)
function contourSPL(freq, phon) {
  const af = isoParam(ISO.af, freq);
  const Lu = isoParam(ISO.Lu, freq);
  const Tf = isoParam(ISO.Tf, freq);

  let Af = 4.47e-3 * (Math.pow(10, 0.025 * phon) - 1.15) +
           Math.pow(0.4 * Math.pow(10, (Tf + Lu) / 10 - 9), af);

  Af = Math.max(Af, 1e-9);
  return (10 / af) * Math.log10(Af) - Lu + 94;
}

// 逆変換: 周波数 / dB SPL → phon
function phonFromSPL(freq, spl) {
  let lo = 0;
  let hi = 100;

  if (spl <= contourSPL(freq, lo)) return 0;
  if (spl >= contourSPL(freq, hi)) return hi;

  for (let k = 0; k < 20; k++) {
    const mid = (lo + hi) / 2;
    if (contourSPL(freq, mid) < spl) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// 既存コードの置き換え: amp は 0〜1 (FFTバイト値/255), 戻り値は 0〜1
function getLoudnessPerceived(freq, amp) {
  if (!freq || !amp) return 0;

  // FFT 解析の dBFS → SPL 近似
  const dbfs = -100 + amp * 70;
  const spl = dbfs + splOffset;

  return constrain(phonFromSPL(freq, spl) / PHON_MAX, 0, 1);
}

// ---------- 色の対応関数 ----------
function hsbColor(h, s, b, a = 255) {
  colorMode(HSB, 360, 100, 100, 255);
  const c = color(h, s, b, a);
  colorMode(RGB, 255);
  return c;
}

function freqRangeMin() {
  return typeof frequencyMapper !== 'undefined' ? frequencyMapper.minFreq : 20;
}

function freqRangeMax() {
  return typeof frequencyMapper !== 'undefined' ? frequencyMapper.maxFreq : 20000;
}

function hueFromFreq(f) {
  const lo = Math.log10(freqRangeMin());
  const hi = Math.log10(freqRangeMax());
  const t = (Math.log10(constrain(f, freqRangeMin(), freqRangeMax())) - lo) / (hi - lo);
  return t * 270;
}

function nmFromHue(h) {
  return 780 - (780 - 380) * (h / 270);
}

function briFromPhon(phon) {
  return map(phon / PHON_MAX, 0.02, 1.0, 30, 100, true);
}

function satFromSpread(sp) {
  return map(Math.log(sp + 1), 0, 9, 100, 20, true);
}

// ---------- 初期化 ----------
function initLoudnessCharts() {
  chartButton = createButton('📈 音と色のグラフ');
  chartButton.position(700, 34);
  styleButton(chartButton, '#8e44ad');
  chartButton.mousePressed(toggleCharts);

  splSlider = createSlider(60, 120, splOffset, 1);
  splSlider.position(350, 72);
  splSlider.input(() => {
    splOffset = splSlider.value();
  });
  splSlider.hide();
}

function toggleCharts() {
  showCharts = !showCharts;
  chartButton.html(showCharts ? '📈 グラフを閉じる' : '📈 音と色のグラフ');
  if (showCharts) splSlider.show();
  else splSlider.hide();
}



// ---------- 描画ユーティリティ ----------
const FMIN = 20;
const FMAX = 20000;

function xOfFreq(f, x, w) {
  return x + w * (Math.log10(constrain(f, FMIN, FMAX)) - Math.log10(FMIN)) / (Math.log10(FMAX) - Math.log10(FMIN));
}

function fmtHz(f) {
  return f >= 1000 ? (f / 1000) + 'k' : String(f);
}

function liveSPL() {
  return -100 + dominantAmplitude * 70 + splOffset;
}

function liveActive() {
  return dominantAmplitude > 0.02 && spectralCentroid > 0;
}

function drawMarker(px, py, col) {
  stroke(30);
  strokeWeight(2);
  fill(col);
  circle(px, py, 14);
}

// ---------- 1) 等ラウドネス曲線 ----------
function drawContourChart(x, y, w, h) {
  const yLo = 0;
  const yHi = 120;
  const yOf = spl => map(spl, yLo, yHi, y + h, y, true);

  fill(255);
  stroke(220);
  strokeWeight(1);
  rect(x, y, w, h, 8);

  textSize(10);
  fill(120);
  noStroke();

  for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    const gx = xOfFreq(f, x, w);
    stroke(235);
    line(gx, y, gx, y + h);
    noStroke();
    textAlign(CENTER, TOP);
    text(fmtHz(f), gx, y + h + 3);
  }

  for (let d = 0; d <= 120; d += 20) {
    const gy = yOf(d);
    stroke(235);
    line(x, gy, x + w, gy);
    noStroke();
    textAlign(RIGHT, CENTER);
    text(d, x - 4, gy);
  }

  fill(80);
  textAlign(LEFT, BOTTOM);
  textSize(12);
  text('等ラウドネス曲線 (ISO 226:2003)  横: 周波数[Hz]  縦: 音圧レベル[dB SPL]', x, y - 4);

  for (const ph of [10, 20, 30, 40, 50, 60, 70, 80, 90]) {
    stroke(lerpColor(color(130, 180, 240), color(20, 30, 110), ph / PHON_MAX));
    strokeWeight(ph % 20 === 0 ? 2.2 : 1.2);
    noFill();

    beginShape();
    for (let i = 0; i <= 120; i++) {
      const f = FMIN * Math.pow(12500 / FMIN, i / 120);
      vertex(xOfFreq(f, x, w), yOf(contourSPL(f, ph)));
    }
    endShape();

    noStroke();
    fill(60);
    textSize(10);
    textAlign(LEFT, CENTER);
    text(ph + ' phon', xOfFreq(12500, x, w) + 3, yOf(contourSPL(12500, ph)));
  }

  if (liveActive()) {
    const px = xOfFreq(dominantFreq, x, w);
    const py = yOf(liveSPL());
    drawMarker(px, py, color(currentColor.r, currentColor.g, currentColor.b));
    noStroke();
    fill(30);
    textSize(11);
    textAlign(LEFT, BOTTOM);

    const ph = phonFromSPL(dominantFreq, liveSPL());
    text(`${dominantFreq.toFixed(0)}Hz / ${liveSPL().toFixed(0)}dB → ${ph.toFixed(0)} phon`,
      constrain(px + 10, x + 4, x + w - 190),
      py - 8
    );
  }
}

// ---------- 2) 周波数 × phon → 色(HSB) のカラーマップ ----------
function getHeatmap(w, h) {
  const key = [w, h, freqRangeMin(), freqRangeMax()].join();
  if (key !== heatKey) {
    if (heatCache) heatCache.remove();

    heatCache = createGraphics(w, h);
    heatCache.pixelDensity(1);
    heatCache.noStroke();
    heatCache.colorMode(HSB, 360, 100, 100);

    const cols = 72;
    const rows = 36;
    const cw = w / cols;
    const ch = h / rows;

    for (let i = 0; i < cols; i++) {
      const f = FMIN * Math.pow(FMAX / FMIN, (i + 0.5) / cols);
      for (let j = 0; j < rows; j++) {
        const ph = PHON_MAX * (1 - (j + 0.5) / rows);
        heatCache.fill(hueFromFreq(f), 85, briFromPhon(ph));
        heatCache.rect(i * cw, j * ch, cw + 1, ch + 1);
      }
    }

    heatKey = key;
  }
  return heatCache;
}

function drawColorMap(x, y, w, h) {
  image(getHeatmap(Math.floor(w), Math.floor(h)), x, y);

  noFill();
  stroke(220);
  strokeWeight(1);
  rect(x, y, w, h, 8);

  textSize(10);
  fill(120);
  noStroke();
  for (const f of [20, 100, 1000, 10000, 20000]) {
    textAlign(CENTER, TOP);
    text(fmtHz(f), xOfFreq(f, x, w), y + h + 3);
  }

  for (let p = 0; p <= PHON_MAX; p += 30) {
    textAlign(RIGHT, CENTER);
    text(p, x - 4, map(p, 0, PHON_MAX, y + h, y));
  }

  fill(80);
  textAlign(LEFT, BOTTOM);
  textSize(12);
  text('色の対応マップ  横: 周波数(→色相)  縦: 感じる大きさ[phon](→明度)', x, y - 4);

  if (liveActive()) {
    const px = xOfFreq(spectralCentroid, x, w);
    const py = map(perceivedLoudness * PHON_MAX, 0, PHON_MAX, y + h, y, true);
    drawMarker(px, py, color(currentColor.r, currentColor.g, currentColor.b));
  }
}

// ---------- 3) HSB 3軸のグラデーションバー ----------
function drawStrip(label, x, y, w, colorAt, leftText, rightText, markerT) {
  const h = 18;

  for (let i = 0; i < w; i += 2) {
    stroke(colorAt(i / w));
    strokeWeight(2.5);
    line(x + i, y, x + i, y + h);
  }

  noFill();
  stroke(190);
  strokeWeight(1);
  rect(x, y, w, h, 4);

  noStroke();
  fill(60);
  textSize(12);
  textAlign(LEFT, BOTTOM);
  text(label, x, y - 3);

  fill(110);
  textSize(10);
  textAlign(LEFT, TOP);
  text(leftText, x, y + h + 3);
  textAlign(RIGHT, TOP);
  text(rightText, x + w, y + h + 3);

  if (markerT !== null && markerT >= 0) {
    const mx = x + w * constrain(markerT, 0, 1);
    fill(30);
    noStroke();
    triangle(mx, y - 1, mx - 5, y - 9, mx + 5, y - 9);
  }
}

function drawHSBStrips(x, y, w) {
  const live = liveActive();
  const curHue = live ? hueFromFreq(spectralCentroid) : 210;
  const curSat = live ? satFromSpread(spectralSpread) : 90;
  const curBri = live ? briFromPhon(perceivedLoudness * PHON_MAX) : 90;
  const lo = Math.log10(freqRangeMin());
  const hi = Math.log10(freqRangeMax());

  drawStrip(
    `H 色相 ← スペクトル重心 ${live ? '(' + curHue.toFixed(0) + '° / ' + nmFromHue(curHue).toFixed(0) + 'nm)' : ''}`,
    x,
    y,
    w,
    t => hsbColor(t * 270, 85, 90),
    `${freqRangeMin().toFixed(0)}Hz 赤 (780nm)`,
    `${freqRangeMax().toFixed(0)}Hz 紫 (380nm)`,
    live ? (Math.log10(constrain(spectralCentroid, freqRangeMin(), freqRangeMax())) - lo) / (hi - lo) : -1
  );

  drawStrip(
    `S 彩度 ← スペクトルの広がり ${live ? '(' + curSat.toFixed(0) + '%)' : ''}`,
    x,
    y + 62,
    w,
    t => hsbColor(curHue, map(t, 0, 1, 100, 20), 90),
    '純音に近い (鮮やか)',
    'ノイズ的 (くすむ)',
    live ? map(Math.log(spectralSpread + 1), 0, 9, 0, 1, true) : -1
  );

  drawStrip(
    `B 明度 ← 感じる大きさ(phon) ${live ? '(' + (perceivedLoudness * PHON_MAX).toFixed(0) + ' phon → ' + curBri.toFixed(0) + '%)' : ''}`,
    x,
    y + 124,
    w,
    t => hsbColor(curHue, 85, briFromPhon(t * PHON_MAX)),
    '0 phon (暗)',
    `${PHON_MAX} phon (明)`,
    live ? perceivedLoudness : -1
  );
}

// ---------- オーバーレイ全体 ----------
function drawLoudnessChartsOverlay() {
  noStroke();
  fill(250, 252, 255, 245);
  rect(0, 70, width, height - 70);

  fill(40);
  textSize(15);
  textAlign(LEFT, TOP);
  text('音を「耳の感度」で補正して色にする仕組み', 20, 74);

  fill(80);
  textSize(11);
  text(`校正: 0 dBFS = ${splOffset} dB SPL`, 20, 104);
  fill(120);
  text('(マイクの実際の感度に合わせてスライダーで調整)', 410, 104);

  const m = 40;
  const top = 150;
  const panelW = (width - m * 3) / 2;
  const panelH = constrain(height - top - 230, 150, 340);

  drawContourChart(m, top, panelW, panelH);
  drawColorMap(m * 2 + panelW, top, panelW, panelH);
  drawHSBStrips(m, top + panelH + 55, width - m * 2);

  fill(120);
  textSize(10);
  textAlign(LEFT, BOTTOM);
  text('G キーでも開閉できます', 20, height - 6);
}
function windowResized() { resizeCanvas(windowWidth, windowHeight); }
 
function mousePressed() {
  for (const s of uiSliders) {
    if (mouseX >= s.x - 14 && mouseX <= s.x + s.w + 14 && abs(mouseY - s.y) <= 18) {
      uiActiveSlider = s.id;
      s.set(map(mouseX, s.x, s.x + s.w, s.min, s.max, true));
      return false;
    }
  }
  for (let i = uiHits.length - 1; i >= 0; i--) {
    const h = uiHits[i];
    if (mouseX >= h.x && mouseX <= h.x + h.w && mouseY >= h.y && mouseY <= h.y + h.h) {
      try {
        const r = h.fn();
        if (r && r.catch) r.catch(e => console.error(e));
      } catch (e) { console.error(e); }
      return false;
    }
  }
}
function mouseDragged() {
  if (!uiActiveSlider) return;
  const s = uiSliders.find(v => v.id === uiActiveSlider);
  if (s) s.set(map(mouseX, s.x, s.x + s.w, s.min, s.max, true));
  return false;
}
function mouseReleased() { uiActiveSlider = null; }
function keyPressed() {
  const i = Number(key) - 1;
  if (i >= 0 && i < UI_TABS.length) uiScreen = UI_TABS[i][0];
}
 
// ================= 音声操作 =================
async function uiToggleMicBtn() {
  try {
    await ensureUserAudioStarted();
    if (!micActive) {
      if (noiseActive) uiStopNoise();
      await audioProcessor.startMicrophone();
      micActive = true;
    } else {
      audioProcessor.stopMicrophone();
      micActive = false;
    }
  } catch (err) {
    console.error(err);
    micActive = false;
    uiToast('マイクを開始できませんでした（許可とHTTPS/localhostを確認）');
  }
}
function uiStopNoise() { audioProcessor.stopOscillator(); noiseActive = false; }
async function uiToggleNoiseBtn() {
  await ensureUserAudioStarted();
  if (!noiseActive) {
    if (micActive) { audioProcessor.stopMicrophone(); micActive = false; }
    audioProcessor.startOscillator();
    noiseActive = true;
  } else {
    uiStopNoise();
  }
}
// alert を使わない版に差し替え
function startCalibration() {
  if (!micActive && !noiseActive) { uiToast('先にマイクかテスト音を開始してね'); return; }
  isCalibrating = true;
  calibrationStartTime = millis();
  tempCollectedFreqs = [];
  tempCollectedSpectraSum = [];
  calibrationFramesCount = 0;
}
 
// ================= UI 部品 =================
function uiText(s, x, y, size, col, ah = LEFT, av = CENTER, bold = false) {
  push(); noStroke(); fill(col); textSize(size); textStyle(bold ? BOLD : NORMAL); textAlign(ah, av); text(s, x, y); pop();
}
function uiCard(x, y, w, h, r = 22) {
  push(); noStroke(); fill(255, 255, 255, 238);
  drawingContext.shadowColor = 'rgba(60,90,140,0.18)';
  drawingContext.shadowBlur = 14; drawingContext.shadowOffsetY = 4;
  rect(x, y, w, h, r); pop();
}
function uiPill(label, x, y, w, h, col, fn) {
  const hover = mouseX > x && mouseX < x + w && mouseY > y && mouseY < y + h;
  const dy = hover ? -2 : 0;
  push(); noStroke(); fill(col);
  drawingContext.shadowColor = 'rgba(0,0,0,0.18)';
  drawingContext.shadowBlur = 8; drawingContext.shadowOffsetY = 3;
  rect(x, y + dy, w, h, h / 2);
  drawingContext.shadowColor = 'transparent';
  fill(255); textAlign(CENTER, CENTER); textStyle(BOLD); textSize(uiMobile ? 14 : 15);
  text(label, x + w / 2, y + h / 2 + dy); pop();
  uiHits.push({ x, y, w, h, fn });
}
function uiSlider(id, label, x, y, w, mn, mx, get, set, fmt) {
  const ty = y + 24, v = get(), t = (v - mn) / (mx - mn);
  uiSliders.push({ id, x, y: ty, w, min: mn, max: mx, set });
  uiText(label, x, y, 14, TH.ink, LEFT, CENTER, true);
  uiText(fmt(v), x + w, y, 13, TH.sub, RIGHT, CENTER);
  push(); strokeCap(ROUND); strokeWeight(9);
  stroke('#d7e3f5'); line(x, ty, x + w, ty);
  stroke(TH.accent); line(x, ty, x + w * t, ty);
  fill(255); strokeWeight(4); circle(x + w * t, ty, 22); pop();
}
function uiToast(s) { uiToastText = s; uiToastUntil = millis() + 3200; }
function uiDrawToast() {
  if (millis() > uiToastUntil) return;
  push(); textSize(14); textStyle(BOLD);
  const w = textWidth(uiToastText) + 44, y = height - (uiMobile ? 160 : 70);
  noStroke(); fill(43, 58, 85, 235); rect(width / 2 - w / 2, y, w, 40, 20);
  fill(255); textAlign(CENTER, CENTER); text(uiToastText, width / 2, y + 20); pop();
}
function rgbToHex(c) {
  return '#' + [c.r, c.g, c.b].map(v => Math.round(constrain(v, 0, 255)).toString(16).padStart(2, '0')).join('');
}
function uiMascot(x, y, s) {
  push(); noStroke(); fill('#5fd4c4');
  circle(x - s * 0.55, y - s * 0.7, s * 0.7); circle(x + s * 0.55, y - s * 0.7, s * 0.7);
  circle(x, y, s * 2);
  fill(255); circle(x - s * 0.38, y - s * 0.05, s * 0.6); circle(x + s * 0.38, y - s * 0.05, s * 0.6);
  fill(TH.ink); circle(x - s * 0.36, y, s * 0.28); circle(x + s * 0.4, y, s * 0.28);
  noFill(); stroke(TH.ink); strokeWeight(2); arc(x, y + s * 0.3, s * 0.6, s * 0.4, 0, PI); pop();
}
 
// ================= レイアウト・背景・ヘッダー・ナビ =================
function uiComputeLayout() {
  const m = 14;
  if (uiMobile) {
    uiLayout = {
      header: { x: 0, y: 0, w: width, h: 56 },
      nav: { x: 8, y: height - 70, w: width - 16, h: 62 },
      content: { x: m, y: 62, w: width - m * 2, h: height - 62 - 76 - 6 }
    };
  } else {
    const sw = 170;
    uiLayout = {
      header: { x: sw + m * 2, y: 10, w: width - sw - m * 3, h: 56 },
      nav: { x: m, y: m, w: sw, h: height - m * 2 },
      content: { x: sw + m * 2, y: 76, w: width - sw - m * 3, h: height - 76 - m }
    };
  }
}
function uiBackground() {
  const g = drawingContext.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, '#bfe6ff'); g.addColorStop(0.6, '#dff3e4'); g.addColorStop(1, '#c9ecb5');
  drawingContext.fillStyle = g; drawingContext.fillRect(0, 0, width, height);
  noStroke(); fill(255, 255, 255, 170);
  for (const [cx, cy, s] of [[0.22, 0.1, 1], [0.62, 0.06, 1.3], [0.88, 0.18, 0.9]]) {
    ellipse(width * cx, height * cy, 120 * s, 40 * s);
    ellipse(width * cx + 30 * s, height * cy - 14 * s, 80 * s, 40 * s);
  }
  fill(150, 215, 120, 110); ellipse(width * 0.2, height + 40, width * 0.9, 260);
  fill(120, 200, 130, 110); ellipse(width * 0.85, height + 60, width * 0.8, 280);
}
function uiHeader() {
  const h = uiLayout.header;
  const st = micActive ? ['マイク接続中', '#2ecc71'] : noiseActive ? ['テスト音再生中', '#ff9f43'] : ['待機中', '#b0bccf'];
  const pw = 150, ph = 34, px = h.x + h.w - pw - (uiMobile ? 12 : 0), py = h.y + (h.h - ph) / 2;
  push(); noStroke(); fill(255, 255, 255, 240); rect(px, py, pw, ph, ph / 2); fill(st[1]); circle(px + 20, py + ph / 2, 11); pop();
  uiText(st[0], px + 34, py + ph / 2, 13, TH.ink, LEFT, CENTER, true);
  if (uiMobile) {
    uiMascot(h.x + 30, h.y + h.h / 2 + 4, 13);
    uiText('Sound × Color', h.x + 56, h.y + h.h / 2, 19, '#2a7fd4', LEFT, CENTER, true);
  } else {
    uiText(UI_TABS.find(t => t[0] === uiScreen)[2], h.x + 6, h.y + h.h / 2, 24, TH.ink, LEFT, CENTER, true);
  }
}
function uiNav() {
  const n = uiLayout.nav;
  uiCard(n.x, n.y, n.w, n.h, 28);
  if (!uiMobile) {
    uiMascot(n.x + 36, n.y + 48, 14);
    uiText('Sound', n.x + 66, n.y + 38, 18, '#2a7fd4', LEFT, CENTER, true);
    uiText('× Color', n.x + 66, n.y + 60, 18, '#e0629a', LEFT, CENTER, true);
    UI_TABS.forEach((t, i) => {
      const x = n.x + 10, y = n.y + 100 + i * 58, w = n.w - 20, h = 48, on = uiScreen === t[0];
      if (on) { push(); noStroke(); fill(TH.accent); rect(x, y, w, h, h / 2); pop(); }
      uiText(t[1] + '  ' + t[2], x + 16, y + h / 2, 15, on ? '#fff' : TH.ink, LEFT, CENTER, true);
      uiHits.push({ x, y, w, h, fn: () => { uiScreen = t[0]; } });
    });
  } else {
    const bw = n.w / 4;
    UI_TABS.forEach((t, i) => {
      const x = n.x + i * bw, on = uiScreen === t[0];
      if (on) { push(); noStroke(); fill('#dff7f3'); rect(x + 6, n.y + 6, bw - 12, n.h - 12, 18); pop(); }
      uiText(t[1], x + bw / 2, n.y + 24, 22, TH.ink, CENTER, CENTER);
      uiText(t[2], x + bw / 2, n.y + 48, 11, on ? TH.accent : TH.sub, CENTER, CENTER, true);
      uiHits.push({ x, y: n.y, w: bw, h: n.h, fn: () => { uiScreen = t[0]; } });
    });
  }
}
 
// ================= ホーム =================
function uiBlob(cx, cy, maxR) {
  uiBlobR = lerp(uiBlobR, maxR * (0.28 + 0.72 * perceivedLoudness), 0.15);
  const col = liveActive() ? currentColor : { r: 200, g: 225, b: 250 };
  const def = (1 - harmonicRatio) * 0.4, n = 96;
  push(); translate(cx, cy);
  drawingContext.shadowColor = `rgba(${col.r | 0},${col.g | 0},${col.b | 0},0.55)`;
  drawingContext.shadowBlur = 30;
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 0) { noStroke(); fill(col.r, col.g, col.b, 235); }
    else { drawingContext.shadowBlur = 0; noFill(); stroke(255, 255, 255, 220); strokeWeight(5); }
    beginShape();
    for (let i = 0; i < n; i++) {
      const a = TWO_PI * i / n;
      const r = uiBlobR * (1 + def * sin(a * 5 + frameCount * 0.05) * perceivedLoudness);
      vertex(r * cos(a), r * sin(a));
    }
    endShape(CLOSE);
  }
  noStroke(); fill(255, 255, 255, 100); ellipse(-uiBlobR * 0.3, -uiBlobR * 0.38, uiBlobR * 0.5, uiBlobR * 0.28);
  pop();
}
function uiRibbon(x, y, w, h) {
  const n = colorHistory.length;
  if (n < 2) return;
  push(); noStroke();
  for (let i = 0; i < n; i += 2) {
    const c = colorHistory[i];
    fill(c.r, c.g, c.b); rect(x + w * i / n, y, w / n * 2 + 1, h);
  }
  pop();
}
function uiHome(c) {
  const statsH = uiMobile ? 150 : 96, topH = c.h - statsH - 12;
  uiCard(c.x, c.y, c.w, topH);
  uiRibbon(c.x + 24, c.y + 16, c.w - 48, 8);
  const cx = c.x + c.w / 2, cy = c.y + 34 + (topH - 34 - 90) / 2;
  uiBlob(cx, cy, min(c.w - 40, topH - 150) / 2);
  if (!micActive && !noiseActive) {
    uiText('「マイク」を押して、声を出してみよう！', cx, c.y + topH - 84, uiMobile ? 14 : 16, TH.sub, CENTER, CENTER, true);
  }
  const bh = 48, gap = 12, bw = uiMobile ? (c.w - 24 - gap) / 2 : 210, by = c.y + topH - bh - 16;
  const bx = cx - (bw * 2 + gap) / 2;
  uiPill(micActive ? '🎤 マイク停止' : '🎤 マイク開始', bx, by, bw, bh, '#4a90e2', uiToggleMicBtn);
  uiPill(noiseActive ? '🔊 テスト音停止' : '🔊 テスト音', bx + bw + gap, by, bw, bh, '#ff8fb1', uiToggleNoiseBtn);
  uiStats(c.x, c.y + topH + 12, c.w, statsH);
}
function uiStats(x, y, w, h) {
  const col = liveActive() ? currentColor : { r: 200, g: 225, b: 250 };
  const items = [
    ['現在の音の色', rgbToHex(col), ''],
    ['主要周波数', dominantFreq > 0 ? Math.round(dominantFreq).toLocaleString() : '—', 'Hz'],
    ['推定 phon', (perceivedLoudness * PHON_MAX).toFixed(1), ''],
    ['スペクトル重心', spectralCentroid > 0 ? Math.round(spectralCentroid).toLocaleString() : '—', 'Hz']
  ];
  const cols = uiMobile ? 2 : 4, rows = uiMobile ? 2 : 1, g = 10;
  const cw = (w - g * (cols - 1)) / cols, ch = (h - g * (rows - 1)) / rows;
  const big = uiMobile ? 20 : 24;
  items.forEach((it, i) => {
    const cx = x + (i % cols) * (cw + g), cy = y + floor(i / cols) * (ch + g);
    uiCard(cx, cy, cw, ch, 18);
    uiText(it[0], cx + 16, cy + ch * 0.3, 12, TH.sub, LEFT, CENTER, true);
    if (i === 0) {
      const d = min(ch * 0.42, 34);
      push(); noStroke(); fill(col.r, col.g, col.b); stroke(255); strokeWeight(3); circle(cx + 16 + d / 2, cy + ch * 0.66, d); pop();
      uiText(it[1], cx + 26 + d, cy + ch * 0.66, big - 4, '#2a7fd4', LEFT, CENTER, true);
    } else {
      push(); textSize(big); textStyle(BOLD); const tw = textWidth(it[1]); pop();
      uiText(it[1], cx + 16, cy + ch * 0.66, big, TH.ink, LEFT, CENTER, true);
      if (it[2]) uiText(it[2], cx + 22 + tw, cy + ch * 0.7, 13, TH.sub, LEFT, CENTER, true);
    }
  });
}
 
// ================= 分析（FFT × 等ラウドネス曲線） =================
function uiChartCard(x, y, w, h, title, sub) {
  uiCard(x, y, w, h);
  uiText(title, x + 18, y + 26, 17, TH.ink, LEFT, CENTER, true);
  push(); textSize(11); textStyle(BOLD);
  const bw = textWidth(sub) + 20;
  noStroke(); fill('#e8f1fc'); rect(x + w - bw - 16, y + 14, bw, 24, 12);
  fill(TH.sub); textAlign(CENTER, CENTER); text(sub, x + w - bw / 2 - 16, y + 26); pop();
  const p = { x: x + 14, y: y + 50, w: w - 28, h: h - 50 - 36 };
  push(); noStroke(); fill(TH.dark); rect(p.x, p.y, p.w, p.h, 16); pop();
  for (const f of [20, 100, 500, 1000, 5000, 20000]) {
    uiText(fmtHz(f), xOfFreq(f, p.x + 8, p.w - 16), p.y + p.h + 16, 11, TH.sub, CENTER, CENTER);
  }
  uiText('周波数 (Hz)', p.x + p.w / 2, p.y + p.h + 30 > y + h - 4 ? y + h - 8 : p.y + p.h + 30, 10, TH.sub, CENTER, CENTER);
  return p;
}
function uiAnalysis(c) {
  const g = 12;
  if (uiMobile) {
    const h = (c.h - g) / 2;
    uiFFTCard(c.x, c.y, c.w, h);
    uiLoudCard(c.x, c.y + h + g, c.w, h);
  } else {
    const statsH = 96, ch = c.h - statsH - g, w = (c.w - g) / 2;
    uiFFTCard(c.x, c.y, w, ch);
    uiLoudCard(c.x + w + g, c.y, w, ch);
    uiStats(c.x, c.y + ch + g, c.w, statsH);
  }
}
function uiFFTCard(x, y, w, h) {
  const p = uiChartCard(x, y, w, h, 'FFTスペクトル', 'リアルタイム');
  const N = uiMobile ? 36 : 56, bw = p.w / N, len = spectrumData.length;
  const nyq = typeof sampleRate === 'function' ? sampleRate() / 2 : 22050;
  const px = p.x + 8, pw = p.w - 16, base = p.y + p.h - 8, maxH = p.h - 26;
  push(); noStroke();
  for (let i = 0; i < N; i++) {
    const f0 = FMIN * Math.pow(FMAX / FMIN, i / N), f1 = FMIN * Math.pow(FMAX / FMIN, (i + 1) / N);
    let mx = 0;
    if (len) {
      const a = Math.max(1, Math.floor(f0 / nyq * len)), b = Math.max(a + 1, Math.ceil(f1 / nyq * len));
      for (let k = a; k < Math.min(b, len); k++) mx = Math.max(mx, spectrumData[k]);
    }
    const bh = Math.max(3, mx / 255 * maxH);
    fill(hsbColor(hueFromFreq(Math.sqrt(f0 * f1)), 75, 100));
    rect(px + i * (pw / N) + 1, base - bh, pw / N - 2, bh, 3);
  }
  // 耳の感度カーブ（40 phon の逆数：高いほど敏感）
  noFill(); stroke(255, 255, 255, 235); strokeWeight(2.5); beginShape();
  const ref = contourSPL(1000, 40);
  for (let i = 0; i <= 80; i++) {
    const f = FMIN * Math.pow(12500 / FMIN, i / 80);
    const sens = map(ref - contourSPL(f, 40), -60, 15, 0, 1, true);
    vertex(xOfFreq(f, px, pw), base - sens * maxH);
  }
  endShape(); pop();
  uiText('━ 耳の感度', p.x + p.w - 12, p.y + 18, 11, '#cfe4ff', RIGHT, CENTER, true);
}
function uiLoudCard(x, y, w, h) {
  const p = uiChartCard(x, y, w, h, '等ラウドネス曲線', 'ISO 226');
  const px = p.x + 8, pw = p.w - 16;
  const yOf = s => map(s, 0, 120, p.y + p.h - 8, p.y + 14, true);
  push();
  for (let d = 0; d <= 120; d += 20) {
    stroke(255, 255, 255, 28); strokeWeight(1); line(p.x + 8, yOf(d), p.x + p.w - 8, yOf(d));
    noStroke(); fill('#7f95b8'); textSize(10); textAlign(LEFT, BOTTOM); text(d, p.x + 12, yOf(d) - 1);
  }
  [20, 40, 60, 80].forEach(ph => {
    const col = hsbColor(map(ph, 20, 80, 190, 320), 55, 100);
    stroke(col); strokeWeight(2.8); noFill(); beginShape();
    for (let i = 0; i <= 100; i++) {
      const f = FMIN * Math.pow(12500 / FMIN, i / 100);
      vertex(xOfFreq(f, px, pw), yOf(contourSPL(f, ph)));
    }
    endShape();
    noStroke(); fill(col); textSize(10); textStyle(BOLD); textAlign(RIGHT, BOTTOM);
    text(ph + ' phon', p.x + p.w - 10, yOf(contourSPL(12500, ph)) - 4);
  });
  pop();
  uiText('dB SPL', p.x + 12, p.y + 12, 10, '#7f95b8', LEFT, CENTER, true);
  if (liveActive()) {
    const mx = xOfFreq(dominantFreq, px, pw), my = yOf(liveSPL());
    push(); drawingContext.shadowColor = 'rgba(255,255,255,0.8)'; drawingContext.shadowBlur = 14;
    fill(currentColor.r, currentColor.g, currentColor.b); stroke(255); strokeWeight(3); circle(mx, my, 16); pop();
    uiText('いまの音', constrain(mx, p.x + 40, p.x + p.w - 40), my - 18, 11, '#fff', CENTER, CENTER, true);
  }
}
 
// ================= 色の軌跡 =================
function uiTrail(c) {
  uiCard(c.x, c.y, c.w, c.h);
  const px = c.x + 14, py = c.y + 14, pw = Math.floor(c.w - 28), ph = Math.floor(c.h - 14 - 70);
  if (!trailG || trailG.width !== pw || trailG.height !== ph) {
    if (trailG) trailG.remove();
    trailG = createGraphics(pw, ph); trailG.pixelDensity(1); trailG.background(20, 28, 58);
  }
  const pressed = mouseIsPressed && mouseX > px && mouseX < px + pw && mouseY > py && mouseY < py + ph;
  if (liveActive() || pressed) {
    let gx, gy;
    const S = min(pw, ph);
    if (pressed) { gx = mouseX - px; gy = mouseY - py; }
    else {
      trailAngle += 0.02 + map(spectralCentroid, 20, 5000, 0, 0.08, true);
      const R = S * 0.16 + perceivedLoudness * S * 0.2;
      gx = pw / 2 + cos(trailAngle) * R * 1.5 + cos(trailAngle * 2.3) * R * 0.35;
      gy = ph / 2 + sin(trailAngle * 1.3) * R + sin(trailAngle * 2.9) * R * 0.3;
    }
    const col = liveActive() ? currentColor : { r: 240, g: 245, b: 255 };
    const r = 3 + perceivedLoudness * 14;
    trailG.noStroke();
    trailG.fill(col.r, col.g, col.b, 50); trailG.circle(gx, gy, r * 4);
    trailG.fill(col.r, col.g, col.b, 220); trailG.circle(gx, gy, r * 1.6);
    trailG.fill(255, 255, 255, 180);
    for (let i = 0; i < 2; i++) trailG.circle(gx + random(-r * 3, r * 3), gy + random(-r * 3, r * 3), random(1, 3));
    trailTouched = true;
  }
  if (trailFade) { trailG.noStroke(); trailG.fill(20, 28, 58, 4); trailG.rect(0, 0, pw, ph); }
  push();
  if (drawingContext.roundRect) { drawingContext.beginPath(); drawingContext.roundRect(px, py, pw, ph, 18); drawingContext.clip(); }
  image(trailG, px, py); pop();
  if (!trailTouched) uiText('声を出すか、指でなぞって絵をかこう！', px + pw / 2, py + ph / 2, 16, '#8fa6d6', CENTER, CENTER, true);
 
  const by = c.y + c.h - 58, bh = 44, g = 10, bw = Math.min(190, (c.w - 28 - g * 2) / 3);
  const bx = c.x + c.w / 2 - (bw * 3 + g * 2) / 2;
  uiPill('🧹 消す', bx, by, bw, bh, '#778ca3', () => { trailG.background(20, 28, 58); trailTouched = false; });
  uiPill(trailFade ? '✨ うすれる' : '✨ のこす', bx + bw + g, by, bw, bh, '#ff9f43', () => { trailFade = !trailFade; });
  uiPill('💾 保存', bx + (bw + g) * 2, by, bw, bh, '#4a90e2', () => { save(trailG, 'sound-color-trail.png'); });
}
 
// ================= せってい =================
function uiSettings(c) {
  uiCard(c.x, c.y, c.w, c.h);
  const x = c.x + 28, w = min(520, c.w - 56), bh = 44;
  let y = c.y + 38;
  uiText('マイクと音の設定', x, y, 18, TH.ink, LEFT, CENTER, true); y += 44;
  uiSlider('spl', '音圧の校正（マイクの感度）', x, y, w, 60, 120, () => splOffset, v => { splOffset = Math.round(v); }, v => `0 dBFS = ${v} dB SPL`); y += 66;
  uiSlider('vol', 'テスト音の音量', x, y, w, 0, 1, () => uiVolume, v => { uiVolume = v; setOutputVolume(v); }, v => Math.round(v * 100) + '%'); y += 70;
  uiPill(isCalibrating ? '⏳ 計測中…' : '⏱️ 3秒で音域をはかる', x, y, w, bh, '#10ac84', () => { if (!isCalibrating) startCalibration(); }); y += bh + 12;
  uiPill('🧹 ノイズプロファイル削除', x, y, w, bh, '#778ca3', () => { noiseProfile = null; uiToast('ノイズプロファイルを消しました'); }); y += bh + 24;
  uiText(`適合音域: ${frequencyMapper.minFreq.toFixed(0)} 〜 ${frequencyMapper.maxFreq.toFixed(0)} Hz`, x, y, 13, TH.sub, LEFT, CENTER, true); y += 22;
  uiText(`ノイズ除去: ${noiseProfile ? 'ON' : 'OFF'}`, x, y, 13, TH.sub, LEFT, CENTER, true);
}
 
