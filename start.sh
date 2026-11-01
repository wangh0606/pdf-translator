#!/usr/bin/env bash
# macOS / Linux launcher
set -u
cd "$(dirname "$0")"
PY=./.venv/bin/python

deps_ok() { [ -x "$PY" ] && "$PY" -c "import fastapi, uvicorn, httpx" >/dev/null 2>&1; }

if ! deps_ok; then
  # 虚拟环境不存在或已损坏（例如缺少 pip）时重新创建
  if ! { [ -x "$PY" ] && "$PY" -m pip --version >/dev/null 2>&1; }; then
    rm -rf .venv
    echo "正在创建虚拟环境 .venv ..."
    if ! python3 -m venv .venv; then
      rm -rf .venv
      echo
      echo "无法创建 Python 虚拟环境。"
      echo "Ubuntu / Debian 请先安装：sudo apt install python3-venv"
      exit 1
    fi
  fi
  echo "正在安装依赖 ..."
  if ! "$PY" -m pip install -r requirements.txt; then
    echo
    echo "依赖安装失败，请检查网络。国内网络可以使用镜像："
    echo "  PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple bash start.sh"
    exit 1
  fi
fi

( sleep 2; (command -v xdg-open >/dev/null && xdg-open http://127.0.0.1:8000) || (command -v open >/dev/null && open http://127.0.0.1:8000) ) >/dev/null 2>&1 &
exec "$PY" server.py "$@"
