/* 
 kintone-keyword-extractor
*/

const axios = require("axios");
const pdfParse = require("pdf-parse/lib/pdf-parse.js") 

const mammoth = require("mammoth");
const XLSX = require("xlsx");

const {
  BedrockRuntimeClient,
  ConverseCommand
} = require("@aws-sdk/client-bedrock-runtime");

const APP_ID = "936";
const FILE_FIELD = "File";
const KEYWORD_FIELD = "SearchKeyword";

const PROMPT_FIELD = "KeywordExtractionPrompt";
const STATUS_FIELD = "KeywordExtractionStatus";
const DATE_FIELD = "KeywordExtractionDate";
const ERROR_FIELD = "KeywordExtractionError";

const MODEL_ID =
  process.env.BEDROCK_MODEL_ID || "amazon.nova-lite-v1:0";
  
const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "ap-northeast-1"
});

function getKintoneClient() {
  const baseURL = process.env.KINTONE_BASE_URL;
  const token = process.env.KINTONE_API_TOKEN;

  if (!baseURL || !token) {
    throw new Error("KINTONE_BASE_URL / KINTONE_API_TOKEN が未設定です");
  }

  return axios.create({
    baseURL: `${baseURL.replace(/\/$/, "")}/k/v1`,
    headers: {
      "X-Cybozu-API-Token": token
    },
    timeout: 60000
  });
}

async function extractText(file) {
  const client = getKintoneClient();

  const response = await client.get("/file.json", {
    params: { fileKey: file.fileKey },
    responseType: "arraybuffer"
  });

  const buffer = Buffer.from(response.data);
  const name = file.name.toLowerCase();

  if (name.endsWith(".pdf")) {
    const result = await pdfParse(buffer);
    return result.text;  
  }

  if (name.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const workbook = XLSX.read(buffer, { type: "buffer" });

    return workbook.SheetNames.map(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      return XLSX.utils.sheet_to_csv(sheet);
    }).join("\n");
  }

  if (name.endsWith(".txt") || name.endsWith(".csv")) {
    return buffer.toString("utf8");
  }

  throw new Error(`未対応のファイル形式です: ${file.name}`);
}

const DEFAULT_PROMPT = `
あなたは社内文書の検索性を改善する専門家です。

次の文書から、検索AIで文書を発見しやすくするための情報を抽出してください。

- 文書に書かれている事実に基づくこと
- 重要な製品名、制度名、業務用語、禁止事項、義務を抽出すること
- 利用者が使いそうな同義語や言い換えも追加すること
- 文書にない規則や事実を作らないこと
- 禁止と許可などの意味を逆転させないこと
- 日本語で簡潔に出力すること
`;

async function generateKeywords(documentText, customPrompt) {
  const instruction =
    customPrompt && customPrompt.trim()
      ? customPrompt.trim()
      : DEFAULT_PROMPT.trim();

  const prompt = `
${instruction}

【必須の出力ルール】
- 文書にない事実を作らないこと
- 出力はJSONオブジェクトのみとすること
- Markdownのコードブロックや説明文を付けないこと
- keywordsは文字列の配列とすること
- questionsは想定される質問の文字列配列とすること
- キーワードは最大20個
- 検索に有効な重要キーワードを優先
- 質問文ではなく、短い名詞句を基本とする
- 重複するキーワードを出力しない
- 指定されたJSON形式だけを返す

出力形式:
{
  "keywords": ["キーワード1", "キーワード2"],
  "questions": ["想定される質問1", "想定される質問2"]
}

【分析対象の文書】
${documentText.slice(0, 40000)}
`;

  const response = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      messages: [
        {
          role: "user",
          content: [{ text: prompt }]
        }
      ],
      inferenceConfig: {
        maxTokens: 2000,
        temperature: 0.1
      }
    })
  );

  console.log("Bedrock stopReason:", response.stopReason);
  console.log(
    "Bedrock output token count:",
    response.usage?.outputTokens
  );

  const output = response.output?.message?.content
    ?.map(item => item.text || "")
    .join("");

  if (!output) {
    throw new Error("Bedrockから空の応答が返されました");
  }


  const jsonText = output
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let result;

  try {
    result = JSON.parse(jsonText);
  } catch (error) {
    const position = Number(
      error.message.match(/position\s+(\d+)/)?.[1] ?? 0
    );

    console.error("JSON parse error:", error.message);
    console.error(
      "問題箇所の前後:",
      jsonText.slice(
        Math.max(0, position - 200),
        Math.min(jsonText.length, position + 200)
      )
    );

    throw error;
  }

  if (
    !Array.isArray(result.keywords) ||
    !result.keywords.every(item => typeof item === "string")
  ) {
    throw new Error("キーワードの出力形式が不正です");
  }

  if (
    result.questions !== undefined &&
    (!Array.isArray(result.questions) ||
      !result.questions.every(item => typeof item === "string"))
  ) {
    throw new Error("想定質問の出力形式が不正です");
  }

  return result;
}

exports.handler = async (event) => {
  let input = event;
  let recordId = "";
  let client;

  try {
    // API Gateway経由とLambda直接呼び出しの両方に対応
    if (typeof event.body === "string") {
      try {
        input = JSON.parse(event.body);
      } catch {
        throw new Error(
          "リクエスト本文が正しいJSONではありません"
        );
      }
    } else if (event.body && typeof event.body === "object") {
      input = event.body;
    }

    recordId = String(input.recordId || "").trim();

    if (!/^\d+$/.test(recordId)) {
      throw new Error(
        "recordIdにはkintoneのレコード番号を指定してください"
      );
    }

    client = getKintoneClient();

    // レコードと添付ファイル、個別プロンプトを取得
    const response = await client.get("/record.json", {
      params: {
        app: APP_ID,
        id: recordId
      }
    });

    const record = response.data.record;
    const files = record[FILE_FIELD]?.value || [];
    const customPrompt = record[PROMPT_FIELD]?.value || "";

    if (files.length === 0) {
      throw new Error("添付ファイルがありません");
    }

    const extracted = [];

    for (const file of files) {
      const text = await extractText(file);

      if (text.trim()) {
        extracted.push(`【ファイル名】${file.name}\n${text}`);
      }
    }

    if (extracted.length === 0) {
      throw new Error(
        "添付ファイルからテキストを抽出できませんでした"
      );
    }

    const documentText = extracted.join("\n\n");

    // レコードに設定されたプロンプトを使用
    const result = await generateKeywords(
      documentText,
      customPrompt
    );

    const keywordText = [
      "【検索キーワード】",
      ...result.keywords,
      "",
      "【想定質問】",
      ...(result.questions || [])
    ].join("\n");

    // 結果と処理状態を一括更新
    await client.put("/record.json", {
      app: APP_ID,
      id: recordId,
      record: {
        [KEYWORD_FIELD]: {
          value: keywordText
        },
        [STATUS_FIELD]: {
          value: "完了"
        },
        [DATE_FIELD]: {
          value: new Date().toISOString()
        },
        [ERROR_FIELD]: {
          value: ""
        }
      }
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        recordId,
        filesProcessed: files.length,
        keywords: result.keywords
      })
    };
  } catch (error) {
    // 失敗した場合も、可能であればkintoneに記録
    if (recordId && client) {
      try {
        await client.put("/record.json", {
          app: APP_ID,
          id: recordId,
          record: {
            [STATUS_FIELD]: {
              value: "エラー"
            },
            [DATE_FIELD]: {
              value: new Date().toISOString()
            },
            [ERROR_FIELD]: {
              value: String(error.message || error).slice(0, 5000)
            }
          }
        });
      } catch (updateError) {
        console.error(
          "エラー状態の保存に失敗しました:",
          updateError.message
        );
      }
    }

    console.error("キーワード抽出エラー:", error);

    // 既存のAPI Gateway経由でも失敗が判別できるようにする
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        recordId: recordId || null,
        error: error.message || "キーワード抽出に失敗しました"
      })
    };
  }
};