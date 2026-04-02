# ================================================================
# WAYBLE Newsletter — 자동 스크랩 & newsletter-data.js 업데이트
# 실행: Git Bash에서 ./publish.sh 또는
#        PowerShell에서 .\scrape.ps1
# ================================================================

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataFile  = Join-Path $scriptDir "newsletter-data.js"

# ── 검색 쿼리 (ESG 관련 키워드) ──────────────────────────────────
$QUERIES = @(
  "ESG 한국 기업 2026",
  "탄소중립 정책 환경부",
  "순환경제 재생에너지"
)

# ────────────────────────────────────────────────────────────────
# 1. RSS 수집
# ────────────────────────────────────────────────────────────────
Write-Host "[1/4] Google News RSS 수집 중..."

$articles   = [System.Collections.ArrayList]@()
$seenTitles = @{}

foreach ($query in $QUERIES) {
  if ($articles.Count -ge 3) { break }

  $encoded = [Uri]::EscapeDataString($query)
  $rssUrl  = "https://news.google.com/rss/search?q=$encoded&hl=ko&gl=KR&ceid=KR:ko"

  try {
    $res  = Invoke-WebRequest -Uri $rssUrl -UseBasicParsing -TimeoutSec 15
    [xml]$xml = $res.Content
    $items = $xml.rss.channel.item

    foreach ($item in $items) {
      if ($articles.Count -ge 3) { break }

      $rawTitle = [string]$item.title

      # 제목 끝 " - 언론사명" 제거
      $title = ($rawTitle -replace '\s+-\s+[^-]+$', '').Trim()

      # 언론사 추출
      $source = ""
      if ($rawTitle -match '\s+-\s+([^-]+)$') { $source = $Matches[1].Trim() }

      # 본문 HTML 정리
      $desc = [string]$item.description
      $desc = $desc -replace '<[^>]+>', ' '
      $desc = $desc -replace '&amp;',  '&'
      $desc = $desc -replace '&lt;',   '<'
      $desc = $desc -replace '&gt;',   '>'
      $desc = $desc -replace '&quot;', '"'
      $desc = $desc -replace '&#39;',  "'"
      $desc = ($desc -replace '\s+', ' ').Trim()

      $rawLink = [string]$item.link

      if (-not $title -or $desc.Length -lt 20 -or $seenTitles[$title]) { continue }
      $seenTitles[$title] = $true

      # Google News 리다이렉트 → 실제 기사 URL 추출
      $realLink = $rawLink
      try {
        $req = [System.Net.HttpWebRequest]::Create($rawLink)
        $req.AllowAutoRedirect = $false
        $req.Timeout  = 5000
        $req.Method   = "HEAD"
        $req.UserAgent = "Mozilla/5.0"
        $resp = $req.GetResponse()
        $loc  = $resp.Headers["Location"]
        if ($loc -and $loc.StartsWith("http")) { $realLink = $loc }
        $resp.Close()
      } catch {}

      [void]$articles.Add(@{
        title  = $title
        desc   = $desc
        link   = $realLink
        source = $source
      })
      Write-Host ("  수집: " + $title + " [" + $source + "]")
    }
  } catch {
    Write-Host ("  RSS 오류 [" + $query + "]: " + $_)
  }
  Start-Sleep -Milliseconds 600
}

if ($articles.Count -lt 3) {
  Write-Host "오류: 기사를 3개 이상 수집하지 못했습니다 ($($articles.Count)개). 중단합니다."
  exit 1
}

# ────────────────────────────────────────────────────────────────
# 2. 호수 계산
# ────────────────────────────────────────────────────────────────
Write-Host "[2/4] 호수 계산 중..."

$existing = Get-Content $dataFile -Raw -Encoding UTF8
$maxIssue = 0
foreach ($m in [regex]::Matches($existing, 'issue:\s*(\d+)')) {
  $n = [int]$m.Groups[1].Value
  if ($n -gt $maxIssue) { $maxIssue = $n }
}
$newIssue = $maxIssue + 1
$today    = Get-Date -Format "yyyy-MM-dd"
Write-Host ("  새 호수: No." + $newIssue + " / 날짜: " + $today)

# ────────────────────────────────────────────────────────────────
# 3. 헤드메시지 & 이슈 요약 생성
# ────────────────────────────────────────────────────────────────
Write-Host "[3/4] 텍스트 생성 중..."

# 헤드메시지: 각 기사 제목에서 핵심 키워드 추출
$keywords = $articles | ForEach-Object {
  $words = $_.title -split '[\s,·\[\]()]+' | Where-Object { $_.Length -ge 2 } | Select-Object -First 2
  $words -join ' '
}
$headMessage = ($keywords -join ' · ') -replace '"', '\"'

# 이슈 요약
$titleList   = ($articles | ForEach-Object { $_.title }) -join ', '
$issueSummary = ($titleList + " 등 이번 주 국내 ESG 핵심 이슈를 정리했습니다.") -replace '"', '\"'

# 각 기사 본문: 2단락으로 구성
function Split-Summary($text) {
  $sents = ($text -split '(?<=[.!?])\s+') | Where-Object { $_.Length -gt 10 }
  if ($sents.Count -le 2) { return $text }
  $half  = [Math]::Ceiling($sents.Count / 2)
  $p1    = ($sents | Select-Object -First $half)  -join ' '
  $p2    = ($sents | Select-Object -Skip  $half)  -join ' '
  return "$p1`n`n$p2"
}

# ────────────────────────────────────────────────────────────────
# 4. newsletter-data.js 스니펫 생성 & 파일 업데이트
# ────────────────────────────────────────────────────────────────
Write-Host "[4/4] newsletter-data.js 업데이트 중..."

# JS 문자열 이스케이프 (역따옴표, ${ 방지)
function Escape-JsTemplate($s) {
  $s = $s -replace '\\',    '\\'
  $s = $s -replace '`',     "'"
  $s = $s -replace '\$\{',  '\${'
  return $s
}

$artBlocks = @()
foreach ($a in $articles) {
  $summary    = Split-Summary $a.desc
  $summaryEsc = Escape-JsTemplate $summary
  $titleEsc   = ($a.title  -replace '"', '\"')
  $sourceEsc  = ($a.source -replace '"', '\"')
  $linkEsc    = ($a.link   -replace '"', '\"')

  $artBlocks += @"
      {
        title: "$titleEsc",
        summary: ``$summaryEsc``,
        source: { press: "$sourceEsc", title: "$titleEsc", date: "$today" },
        link: "$linkEsc"
      }
"@
}

$artsJoined = $artBlocks -join ",`n"

$snippet = @"
  {
    issue: $newIssue,
    date: "$today",
    headMessage: "$headMessage",
    summary: "$issueSummary",
    articles: [
$artsJoined
    ]
  },

"@

# "const NEWSLETTERS = [" 다음 줄에 스니펫 삽입
$marker     = "const NEWSLETTERS = ["
$newContent = $existing -replace [regex]::Escape($marker), ($marker + "`n" + $snippet)

# UTF-8 BOM 없이 저장
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($dataFile, $newContent, $utf8NoBom)

Write-Host ""
Write-Host "================================================"
Write-Host " 완료! No.$newIssue 생성됨"
Write-Host "================================================"
Write-Host ""
Write-Host "수집된 기사:"
$i = 1
foreach ($a in $articles) {
  Write-Host ("  $i. " + $a.title)
  Write-Host ("     URL: " + $a.link)
  $i++
}
Write-Host ""
Write-Host "다음 단계: publish.sh 를 실행하거나 아래 명령어로 배포하세요"
Write-Host "  git add newsletter-data.js"
Write-Host "  git commit -m 'No.$newIssue 발행: $today'"
Write-Host "  git push"
