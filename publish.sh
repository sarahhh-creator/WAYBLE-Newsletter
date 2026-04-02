#!/bin/bash
# ================================================================
# WAYBLE Newsletter — 자동 스크랩 + GitHub 배포 (Git Bash용)
# 사용법: ./publish.sh
# ================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "========================================"
echo " WAYBLE Newsletter 자동 발행 시작"
echo "========================================"
echo ""

# ── 1. PowerShell 스크립트로 뉴스 스크랩 ──
echo "[STEP 1] ESG 뉴스 자동 수집 중..."
powershell.exe -ExecutionPolicy Bypass -File "./scrape.ps1"

if [ $? -ne 0 ]; then
  echo ""
  echo "오류: 스크랩 실패. 위 오류 메시지를 확인하세요."
  exit 1
fi

echo ""
echo "[STEP 2] GitHub에 배포 중..."

# ── 2. 변경 내용 확인 ──
if ! git diff --quiet newsletter-data.js; then
  ISSUE=$(grep -oP 'issue:\s*\K\d+' newsletter-data.js | sort -n | tail -1)
  DATE=$(date +%Y-%m-%d)

  git add newsletter-data.js
  git commit -m "No.${ISSUE} 발행: ${DATE}"
  git push

  echo ""
  echo "========================================"
  echo " 배포 완료! No.${ISSUE}"
  echo " 1~2분 후 사이트에 반영됩니다."
  echo "========================================"
else
  echo ""
  echo "newsletter-data.js 에 변경 사항이 없습니다."
fi

echo ""
