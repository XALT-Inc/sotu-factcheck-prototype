export function pcm16ToWav(pcmBuffer, options = {}) {
  const sampleRate = options.sampleRate ?? 16000;
  const channels = options.channels ?? 1;
  const bitDepth = options.bitDepth ?? 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBuffer.length;
  const wavSize = 44 + dataSize;

  const wav = Buffer.alloc(wavSize);
  let offset = 0;

  wav.write('RIFF', offset);
  offset += 4;
  wav.writeUInt32LE(wavSize - 8, offset);
  offset += 4;
  wav.write('WAVE', offset);
  offset += 4;

  wav.write('fmt ', offset);
  offset += 4;
  wav.writeUInt32LE(16, offset);
  offset += 4;
  wav.writeUInt16LE(1, offset);
  offset += 2;
  wav.writeUInt16LE(channels, offset);
  offset += 2;
  wav.writeUInt32LE(sampleRate, offset);
  offset += 4;
  wav.writeUInt32LE(byteRate, offset);
  offset += 4;
  wav.writeUInt16LE(blockAlign, offset);
  offset += 2;
  wav.writeUInt16LE(bitDepth, offset);
  offset += 2;

  wav.write('data', offset);
  offset += 4;
  wav.writeUInt32LE(dataSize, offset);
  offset += 4;

  pcmBuffer.copy(wav, offset);

  return wav;
}
