#!/bin/bash

# Batch evaluation script for LongMemEval results
# Usage: ./evaluate-batch.sh --runId=<runId> [--questionType=<questionType>] [--startPosition=<startPos>] [--endPosition=<endPos>]

set -e

# Function to parse arguments
parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --runId=*) RUN_ID="${1#*=}" ;;
            --questionType=*) QUESTION_TYPE="${1#*=}" ;;
            --startPosition=*) START_POS="${1#*=}" ;;
            --endPosition=*) END_POS="${1#*=}" ;;
            *) echo "Unknown parameter passed: $1"; exit 1 ;;
        esac
        shift
    done
}

parse_args "$@"

if [ -z "$RUN_ID" ]; then
    echo "Usage: ./evaluate-batch.sh --runId=<runId> [--questionType=<questionType>] [--startPosition=<startPos>] [--endPosition=<endPos>]"
    echo "Example: ./evaluate-batch.sh --runId=run1"
    echo "Example: ./evaluate-batch.sh --runId=run1 --questionType=single-session-user"
    echo "Example: ./evaluate-batch.sh --runId=run1 --questionType=single-session-user --startPosition=1 --endPosition=50"
    exit 1
fi

# Get script directory and root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "Starting evaluation..."
echo "Run ID: $RUN_ID"
echo "Model: gemini-3-pro-preview"
if [ -n "$QUESTION_TYPE" ]; then
    echo "Question type: $QUESTION_TYPE"
else
    echo "Question type: all"
fi

if [ -n "$START_POS" ] && [ -n "$END_POS" ]; then
    echo "Processing range: $START_POS to $END_POS"
else
    echo "Using all results from each file"
fi
echo ""

if [ -n "$START_POS" ] && [ -n "$END_POS" ]; then
    # When using start/end pos, we must provide the question type argument (use "all" if not specified)
    TYPE_ARG="${QUESTION_TYPE:-all}"
    cd "$ROOT_DIR" && bun run scripts/evaluate/evaluate.ts "$RUN_ID" "$TYPE_ARG" "$START_POS" "$END_POS"
elif [ -n "$QUESTION_TYPE" ]; then
    cd "$ROOT_DIR" && bun run scripts/evaluate/evaluate.ts "$RUN_ID" "$QUESTION_TYPE"
else
    cd "$ROOT_DIR" && bun run scripts/evaluate/evaluate.ts "$RUN_ID"
fi
