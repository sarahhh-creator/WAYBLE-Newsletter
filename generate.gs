// ================================================================
// WAYBLE Newsletter — Google Apps Script 자동화 스크립트
// ================================================================
//
// [사용 방법]
// 1. script.google.com → 새 프로젝트 → 이 코드 전체 붙여넣기
// 2. 아래 CONFIG의 SHEET_ID 입력 (Gemini는 선택)
// 3. runManual() 실행해서 테스트
// 4. [배포] → [새 배포] → 웹앱 (액세스: 모든 사용자)
// 5. 배포 URL → newsletter.html / index.html 의 GAS_ENDPOINT 에 입력
// 6. 자동 트리거: generateWeeklyNewsletter → 매주 월요일 오전 8시
//
// ★ Gemini 없이도 완전히 동작합니다.
//   USE_GEMINI: false 이면 RSS 원문을 그대로 사용합니다.
// ================================================================

const CONFIG = {
  // ── 필수 ──
  // Google Sheets ID: 시트 URL의 /d/★여기★/edit 부분
  SHEET_ID: "YOUR_GOOGLE_SHEET_ID_HERE",

  // ── 선택: Gemini AI 요약 ──
  // false = Gemini 없이 RSS 원문 사용 (기본값, 바로 동작)
  // true  = Gemini로 요약 (AI Studio에서 API 키 발급 필요)
  USE_GEMINI: false,
  GEMINI_API_KEY: "",
  GEMINI_MODEL: "gemini-2.0-flash-lite",

  // ── 뉴스 검색 키워드 (Google News RSS) ──
  // 쉼표로 구분해 여러 쿼리 설정 가능
  NEWS_QUERIES: [
    "ESG 한국 기업",
    "탄소중립 정책",
    "순환경제 환경부",
  ],

  // ── 시트 이름 ──
  SHEET_NEWSLETTERS:   "Newsletters",
  SHEET_SUBSCRIPTIONS: "Subscriptions",
  SHEET_FEEDBACK:      "Feedback",
};


// ================================================================
// 0. 수동 실행 — GAS 에디터에서 직접 테스트할 때 사용
// ================================================================
function runManual() {
  const today = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
  generateNewsletter(today);
}


// ================================================================
// 1. 주간 자동 실행 — 트리거로 매주 월요일 호출
// ================================================================
function generateWeeklyNewsletter() {
  const today = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
  generateNewsletter(today);
}


// ================================================================
// 2. 메인 함수
// ================================================================
function generateNewsletter(dateStr) {
  Logger.log("=== WAYBLE Newsletter 생성 시작 / 날짜: " + dateStr + " ===");

  try {
    // ① RSS에서 기사 수집
    const articles = fetchESGNews(3);
    if (articles.length < 3) {
      Logger.log("기사 부족 (수집: " + articles.length + "개). 중단.");
      return;
    }
    Logger.log("수집된 기사 수: " + articles.length);
    articles.forEach((a, i) => Logger.log((i+1) + ". " + a.title + " → " + a.link));

    // ② 각 기사 요약 (Gemini 또는 RSS 원문)
    const summarized = [];
    for (const art of articles) {
      Logger.log("요약 중: " + art.title);
      const summary = CONFIG.USE_GEMINI && CONFIG.GEMINI_API_KEY
        ? summarizeWithGemini(art.title, art.description)
        : formatRssSummary(art.title, art.description, art.source, art.pubDate);
      summarized.push({ title: art.title, summary: summary, link: art.link, source: art.source });
      if (CONFIG.USE_GEMINI) Utilities.sleep(1500);
    }

    // ③ 호수 계산
    const sheet    = getOrCreateSheet(CONFIG.SHEET_NEWSLETTERS);
    const lastRow  = sheet.getLastRow();
    const issueNum = lastRow <= 1 ? 1 : lastRow;

    // ④ 헤드메시지 & 이슈 요약
    const headMessage  = CONFIG.USE_GEMINI && CONFIG.GEMINI_API_KEY
      ? generateHeadMessageGemini(summarized)
      : generateHeadMessageSimple(summarized);
    const issueSummary = CONFIG.USE_GEMINI && CONFIG.GEMINI_API_KEY
      ? generateIssueSummaryGemini(summarized)
      : generateIssueSummarySimple(summarized);

    // ⑤ 시트 저장
    if (lastRow === 0) {
      sheet.appendRow(["issue","date","headMessage","summary",
        "title1","summary1","link1","source1",
        "title2","summary2","link2","source2",
        "title3","summary3","link3","source3"]);
    }
    sheet.appendRow([
      issueNum, dateStr, headMessage, issueSummary,
      summarized[0].title, summarized[0].summary, summarized[0].link, summarized[0].source || "",
      summarized[1].title, summarized[1].summary, summarized[1].link, summarized[1].source || "",
      summarized[2].title, summarized[2].summary, summarized[2].link, summarized[2].source || "",
    ]);

    // ⑥ newsletter-data.js 스니펫 생성 → 로그 + 이메일 발송
    const snippet = buildJsSnippet(issueNum, dateStr, headMessage, issueSummary, summarized);
    Logger.log("\n=== newsletter-data.js 에 추가할 코드 ===\n" + snippet + "\n=====================================");
    sendSnippetEmail(issueNum, snippet);

    Logger.log("=== 생성 완료! No." + issueNum + " ===");

  } catch (err) {
    Logger.log("오류: " + err.toString());
    try {
      MailApp.sendEmail(Session.getActiveUser().getEmail(),
        "[WAYBLE Newsletter] 생성 오류", "오류 내용:\n" + err.toString());
    } catch(e2) {}
  }
}


// ================================================================
// 3. Google News RSS 스크랩
//    - CONFIG.NEWS_QUERIES 의 키워드를 순환하며 기사 수집
//    - 중복 제거 후 최신 기사 반환
// ================================================================
function fetchESGNews(count) {
  const seen    = {};
  const results = [];

  for (const query of CONFIG.NEWS_QUERIES) {
    if (results.length >= count) break;
    const encoded = encodeURIComponent(query);
    const url = "https://news.google.com/rss/search?q=" + encoded + "&hl=ko&gl=KR&ceid=KR:ko";

    try {
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) continue;

      const doc   = XmlService.parse(res.getContentText("UTF-8"));
      const items = doc.getRootElement().getChild("channel").getChildren("item");

      for (let i = 0; i < items.length && results.length < count; i++) {
        const item  = items[i];
        const rawTitle = item.getChildText("title") || "";
        const rawDesc  = item.getChildText("description") || "";
        const rawLink  = item.getChildText("link") || "";
        const pubDate  = item.getChildText("pubDate") || "";

        // 제목 끝 " - 언론사명" 제거
        const title = rawTitle.replace(/\s+-\s+[^-]+$/, "").trim();

        // HTML 태그 / 특수문자 정리
        const desc = rawDesc
          .replace(/<[^>]+>/g, " ")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ")
          .trim();

        // 언론사명 추출 (제목의 " - 언론사" 부분)
        const sourceMatch = rawTitle.match(/\s+-\s+([^-]+)$/);
        const source = sourceMatch ? sourceMatch[1].trim() : "";

        // 실제 기사 URL 추출 (Google News 리다이렉트 → 원본 URL)
        const realLink = resolveGoogleNewsLink(rawLink);

        if (!title || desc.length < 30 || seen[title]) continue;
        seen[title] = true;

        results.push({ title, description: desc, link: realLink, source, pubDate });
      }
    } catch (e) {
      Logger.log("RSS 오류 [" + query + "]: " + e.toString());
    }

    Utilities.sleep(500);
  }

  return results;
}


// ================================================================
// 4. Google News 리다이렉트 URL → 실제 기사 URL 추출
// ================================================================
function resolveGoogleNewsLink(googleUrl) {
  try {
    // Google News RSS 링크에서 실제 URL을 추출하는 방법:
    // URL 파라미터 또는 리다이렉트 헤더에서 가져옴
    const res = UrlFetchApp.fetch(googleUrl, {
      followRedirects: false,
      muteHttpExceptions: true,
    });
    const location = res.getHeaders()["Location"];
    if (location && location.startsWith("http")) return location;

    // Location 헤더 없으면 원본 URL 그대로 반환 (구글 뉴스 링크도 동작함)
    return googleUrl;
  } catch (e) {
    return googleUrl;
  }
}


// ================================================================
// 5. RSS 설명을 뉴스레터 형식으로 포맷 (Gemini 없이 사용)
// ================================================================
function formatRssSummary(title, description, source, pubDate) {
  // RSS description을 2~3단락으로 자연스럽게 나눔
  const sentences = description
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 10);

  if (sentences.length === 0) return description;

  // 문장을 3개 그룹으로 나눠 단락 구성
  const chunkSize = Math.ceil(sentences.length / 3);
  const paras = [];
  for (let i = 0; i < sentences.length; i += chunkSize) {
    paras.push(sentences.slice(i, i + chunkSize).join(" "));
  }

  return paras.join("\n\n");
}


// ================================================================
// 6. 헤드메시지 & 이슈 요약 (Gemini 없는 버전)
// ================================================================
function generateHeadMessageSimple(articles) {
  // 각 기사 제목에서 핵심 명사 추출해 조합
  const keywords = articles.map(a => {
    const words = a.title.split(/[\s·,]+/).filter(w => w.length >= 2);
    return words.slice(0, 2).join(" ");
  });
  return keywords.join(" · ");
}

function generateIssueSummarySimple(articles) {
  return articles.map(a => a.title).join(", ") + " 등 이번 주 ESG 핵심 이슈를 정리했습니다.";
}


// ================================================================
// 7. 헤드메시지 & 이슈 요약 (Gemini 버전)
// ================================================================
function generateHeadMessageGemini(articles) {
  const titles = articles.map(a => a.title).join(", ");
  const prompt = `아래 ESG 뉴스 제목 3개를 보고, 이번 주 뉴스레터를 대표하는 헤드메시지를 작성해주세요.
형식: "키워드1·키워드2·키워드3" 형태의 개조식 명사형 30자 이내. 마침표 없음.
예시: "RE100 가입 급증·ESG 평가 기준 강화·순환경제 정책 전환"

기사 제목들: ${titles}

헤드메시지:`;
  return callGemini(prompt, 100).replace(/["']/g, "").trim();
}

function generateIssueSummaryGemini(articles) {
  const titles = articles.map(a => a.title).join("\n- ");
  const prompt = `아래 ESG 기사 3개를 바탕으로 뉴스레터 도입부 요약을 2~3문장으로 작성해주세요. 80자 내외.

기사 목록:
- ${titles}

요약:`;
  return callGemini(prompt, 300).trim();
}


// ================================================================
// 8. Gemini API 공통 호출
// ================================================================
function summarizeWithGemini(title, content) {
  const prompt = `당신은 ESG 전문 편집자입니다.
아래 기사를 한국어로 800자 이상 1200자 이내로 요약해주세요.

요약 기준:
- 기업/정책/시장 관점에서 핵심 내용 전달
- ESG 트렌드와 연결한 시사점 포함
- 문단 구분은 빈 줄(줄바꿈 두 번)로 표시
- 정제된 문체 사용

기사 제목: ${title}
기사 내용: ${content}

요약:`;
  return callGemini(prompt, 2048).trim();
}

function callGemini(prompt, maxTokens) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/"
    + CONFIG.GEMINI_MODEL + ":generateContent?key=" + CONFIG.GEMINI_API_KEY;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.5, maxOutputTokens: maxTokens },
  };
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const result = JSON.parse(res.getContentText());
  if (result.error) throw new Error("Gemini 오류: " + result.error.message);
  return result.candidates[0].content.parts[0].text;
}


// ================================================================
// 9. newsletter-data.js 스니펫 생성
// ================================================================
function buildJsSnippet(issueNum, date, headMessage, summary, articles) {
  const arts = articles.map(a => {
    const escSummary = a.summary.replace(/`/g, "'");
    const sourceObj  = a.source
      ? `{ press: ${JSON.stringify(a.source)}, title: ${JSON.stringify(a.title)}, date: ${JSON.stringify(date)} }`
      : "null";
    return [
      "      {",
      "        title: " + JSON.stringify(a.title) + ",",
      "        summary: `" + escSummary + "`,",
      "        source: " + sourceObj + ",",
      "        link: " + JSON.stringify(a.link),
      "      }",
    ].join("\n");
  }).join(",\n");

  return [
    "  {",
    "    issue: " + issueNum + ",",
    "    date: " + JSON.stringify(date) + ",",
    "    headMessage: " + JSON.stringify(headMessage) + ",",
    "    summary: " + JSON.stringify(summary) + ",",
    "    articles: [",
    arts,
    "    ]",
    "  },",
  ].join("\n");
}


// ================================================================
// 10. 이메일로 스니펫 발송
// ================================================================
function sendSnippetEmail(issueNum, snippet) {
  try {
    const email = Session.getActiveUser().getEmail();
    MailApp.sendEmail({
      to: email,
      subject: "[WAYBLE Newsletter] No." + issueNum + " 생성 완료 — newsletter-data.js 업데이트 필요",
      body: [
        "WAYBLE Newsletter No." + issueNum + " 자동 생성이 완료되었습니다.",
        "",
        "아래 코드를 newsletter-data.js 의 NEWSLETTERS 배열 맨 앞에 붙여넣고",
        "GitHub에 push 하면 사이트에 반영됩니다.",
        "",
        "─────────────────────────────",
        snippet,
        "─────────────────────────────",
        "",
        "GitHub 업데이트 명령어:",
        "  git add newsletter-data.js",
        "  git commit -m \"No." + issueNum + " 발행: " + issueNum + "\"",
        "  git push",
      ].join("\n"),
    });
    Logger.log("이메일 발송 완료: " + email);
  } catch (e) {
    Logger.log("이메일 발송 실패: " + e.toString());
  }
}


// ================================================================
// 11. 구독 / 피드백 처리 (HTTP POST 핸들러)
// ================================================================
function doPost(e) {
  try {
    const params = e.parameter;
    const type   = params.type || "subscribe";

    if (type === "feedback") {
      const content = params.content || "";
      const email   = params.email   || "";
      const issue   = params.issue   || "";
      if (!content) return jsonResponse({ success: false, error: "내용 없음" });

      const sheet = getOrCreateSheet(CONFIG.SHEET_FEEDBACK);
      if (sheet.getLastRow() === 0) sheet.appendRow(["timestamp","issue","content","email"]);
      sheet.appendRow([now(), issue, content, email]);
      return jsonResponse({ success: true });
    }

    // 구독 신청
    const name    = params.name  || "";
    const email   = params.email || "";
    const privacy = params.privacyAgree   === "true";
    const mkt     = params.marketingAgree === "true";
    if (!name || !email || !privacy || !mkt)
      return jsonResponse({ success: false, error: "필수 항목 누락" });

    const sheet = getOrCreateSheet(CONFIG.SHEET_SUBSCRIPTIONS);
    if (sheet.getLastRow() === 0) sheet.appendRow(["timestamp","name","email","privacyAgree","marketingAgree"]);
    sheet.appendRow([now(), name, email, privacy, mkt]);
    return jsonResponse({ success: true });

  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}


// ================================================================
// 12. 뉴스레터 데이터 제공 (HTTP GET)
// ================================================================
function doGet(e) {
  const sheet = getOrCreateSheet(CONFIG.SHEET_NEWSLETTERS);
  const data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return jsonResponse({ newsletters: [] });

  const newsletters = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r[0]) continue;
    newsletters.push({
      issue:       r[0],
      date:        r[1] ? Utilities.formatDate(new Date(r[1]), "Asia/Seoul", "yyyy-MM-dd") : "",
      headMessage: r[2] || "",
      summary:     r[3] || "",
      articles: [
        { title: r[4]||"", summary: r[5]||"", link: r[6]||"", source: { press: r[7]||"" } },
        { title: r[8]||"", summary: r[9]||"", link: r[10]||"", source: { press: r[11]||"" } },
        { title: r[12]||"", summary: r[13]||"", link: r[14]||"", source: { press: r[15]||"" } },
      ],
    });
  }
  newsletters.sort((a, b) => b.issue - a.issue);
  return jsonResponse({ newsletters });
}


// ================================================================
// 유틸
// ================================================================
function getOrCreateSheet(name) {
  const ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sheet   = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function now() {
  return Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm:ss");
}
