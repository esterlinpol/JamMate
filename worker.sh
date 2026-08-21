#!/bin/sh
# Convenience launcher for the Mac worker.
#
# Server and device come from the environment (see worker.py), so set the server
# once in your shell profile instead of retyping it:
#   export JAMMATE_SERVER=http://192.168.1.5:8000
#
# --device stays mps here, as it was before, so this script keeps using the GPU
# unless you say otherwise. Any argument still overrides: ./worker.sh --device cpu
: "${JAMMATE_DEVICE:=mps}"
export JAMMATE_DEVICE
python "$(dirname "$0")/worker.py" "$@"
