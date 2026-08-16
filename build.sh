#!/bin/bash
# Roda automaticamente a cada deploy do Cloudflare Pages.
# Troca os placeholders __API_URL__ e __API_SECRET__ do frontend pelos valores
# configurados em Pages > Settings > Environment variables — nunca ficam no Git.
set -e

if [ -z "$API_URL" ] || [ -z "$API_SECRET" ]; then
  echo "ERRO: configure as variáveis de ambiente API_URL e API_SECRET no Cloudflare Pages (Settings > Environment variables) antes de fazer deploy."
  exit 1
fi

mkdir -p dist
sed "s|__API_URL__|$API_URL|g; s|__API_SECRET__|$API_SECRET|g" frontend/index.html > dist/index.html

echo "Build ok — dist/index.html gerado com as credenciais injetadas."
