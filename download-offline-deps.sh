#!/usr/bin/env bash
# =============================================================================
# download-offline-deps.sh
#
# Run this script ONCE on a machine that has internet access.
# It downloads all JavaScript libraries needed by BAS_PM_Generator_v10.html
# into a local libs/ directory so the app works on airgapped networks.
#
# After running, open the HTML file in a browser and everything loads locally.
# The MiniLM sentence-embedding model (~25 MB) is cached automatically in the
# browser's IndexedDB on first use; that also requires a one-time internet
# connection.  If you need fully offline MiniLM as well, see the note at the
# bottom of this file.
#
# Usage:
#   chmod +x download-offline-deps.sh
#   ./download-offline-deps.sh
# =============================================================================

set -e

PDFJS_VERSION="3.11.174"
COMPROMISE_VERSION="14.14.0"
TRANSFORMERS_VERSION="2.17.2"

mkdir -p libs/pdfjs libs/transformers

echo "=== Downloading pdf.js ${PDFJS_VERSION} ==="
curl -fL "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js" \
     -o "libs/pdfjs/pdf.min.js"
curl -fL "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js" \
     -o "libs/pdfjs/pdf.worker.min.js"

echo "=== Downloading compromise ${COMPROMISE_VERSION} ==="
curl -fL "https://unpkg.com/compromise@${COMPROMISE_VERSION}/builds/compromise.min.js" \
     -o "libs/compromise.min.js"

echo "=== Downloading Transformers.js ${TRANSFORMERS_VERSION} ==="
curl -fL "https://cdn.jsdelivr.net/npm/@xenova/transformers@${TRANSFORMERS_VERSION}/dist/transformers.min.js" \
     -o "libs/transformers/transformers.min.js"

echo ""
echo "=== Done! libs/ directory contents: ==="
find libs/ -type f | sort

echo ""
echo "Next steps:"
echo "  1. Update the <script> tags in BAS_PM_Generator_v10.html to point to ./libs/"
echo "     (see the AIRGAPPED SETUP section in the HTML comments)"
echo "  2. Copy the entire PM-Generator folder to the airgapped machine."
echo ""
echo "NOTE: The MiniLM sentence-embedding model weights (~25 MB) are downloaded"
echo "      separately by the browser and cached in IndexedDB on first use."
echo "      To pre-cache them offline, run download-miniLM-model.sh (see below)"
echo "      and serve the model from libs/models/ using a local HTTP server."
