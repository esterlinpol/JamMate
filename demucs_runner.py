"""
Wrapper that patches torchaudio.save to use soundfile before importing demucs.
Required because torchaudio 2.11+ hardcodes torchcodec as the only save backend.
"""
import sys
import soundfile as sf
import torchaudio


def _save(uri, src, sample_rate, encoding=None, bits_per_sample=None, **kwargs):
    subtype = "PCM_16"
    if encoding == "PCM_S":
        subtype = {16: "PCM_16", 24: "PCM_24", 32: "PCM_32"}.get(bits_per_sample, "PCM_16")
    elif encoding == "PCM_F":
        subtype = {32: "FLOAT", 64: "DOUBLE"}.get(bits_per_sample, "FLOAT")
    sf.write(str(uri), src.numpy().T, sample_rate, subtype=subtype)


torchaudio.save = _save

from demucs.__main__ import main  # noqa: E402
sys.exit(main() or 0)
