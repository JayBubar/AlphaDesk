#!/usr/bin/env bash
set -e

echo ""
echo "  AlphaDesk — Local Setup"
echo "  ========================"
echo ""

# Node deps
echo "→ Installing Node dependencies..."
npm install

# Python deps
echo "→ Installing Python dependencies..."
cd backend
python3 -m pip install -r requirements.txt --quiet
cd ..

echo ""
echo "  ✓ Setup complete!"
echo ""
echo "  To start:"
echo "    npm run dev"
echo ""
echo "  Frontend → http://localhost:3000"
echo "  Backend  → http://localhost:8000"
echo "  API docs → http://localhost:8000/docs"
echo ""
