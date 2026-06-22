#!/bin/sh
python "$(dirname "$0")/worker.py" --server http://localhost:8000 --device mps "$@"
