// Predefined form schemas - mirrors app/forms/ from the backend
// Each schema provides: tool definition, instructions, and URL matching

const FORM_SCHEMAS = {
  taxi: {
    id: 'taxi',
    label: '計程車費請領單',
    urlPattern: 'XZF0_0450/prompt',
    urlContains: '67e11db3fbb2b7a2faebc735',
    instructions: `你是計程車費報銷表單助理。請用繁體中文對話引導使用者完成表單。
回覆請簡短扼要，每次回覆不超過兩句話。

必填欄位（缺一不可，全部確認才能送出）：
1. 乘坐日期（格式 YYYY-MM-DD，必須問清楚具體日期）
2. 乘車時段（平日白天/平日晚上/假日，沒提到就預設平日白天 01_平日(08~21)）
3. 乘坐類型（單趟/來回/多趟。來回就是 02_單日來回）
4. 每趟的起點、迄點、費用、事由（全部都要有值）
5. 車資合計（可以自己從 rideRows 的 fee 加總計算）

重要規則：
- 使用者一次把所有必填資訊說完才可以直接填，不需要逐一確認
- 不可自行編造使用者沒提供的日期、地點、費用或事由
- 日期格式必須是 YYYY-MM-DD（例：今天是2026-05-15）
- 費用必須是純數字字串
- 車資合計 = 所有趟次的 fee 加總，你可以自己算不需要問使用者
- 乘車時段沒提到就預設 01_平日(08~21)
- 來回就是 02_單日來回，兩筆 rideRows（去程跟回程）
- 如果使用者說「來回」且每趟150，就自動產生兩筆 rideRows 並算合計300
- 使用者說「確認沒問題幫我送出」但必填資訊不足時，仍然要追問缺少內容`,
    toolSchema: {
      type: 'function',
      function: {
        name: 'fill_form',
        description: '當所有必填欄位完整時，填入計程車費請領單。',
        parameters: {
          type: 'object',
          properties: {
            ridePeriod: {
              type: 'string',
              enum: ['01_平日(08~21)', '02_平日(22~07)', '03_假日'],
              description: '乘車時段：平日白天=01_平日(08~21)、平日晚上=02_平日(22~07)、假日=03_假日'
            },
            rideDate: {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
              description: '乘坐日期，格式 YYYY-MM-DD'
            },
            rideType: {
              type: 'string',
              enum: ['01_單日單趟', '02_單日來回', '03_單日多趟(請於備註說明)'],
              description: '乘坐類型：單趟=01_單日單趟、來回=02_單日來回、多趟=03_單日多趟(請於備註說明)'
            },
            rideRows: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  from: { type: 'string', description: '乘坐起點' },
                  to: { type: 'string', description: '乘坐迄點' },
                  fee: { type: 'string', description: '費用（純數字）' },
                  reason: { type: 'string', description: '乘坐事由' }
                },
                required: ['from', 'to', 'fee', 'reason']
              },
              description: '乘坐起迄明細，至少一筆',
              minItems: 1
            },
            totalFare: {
              type: 'string',
              description: '當日車資合計（純數字）'
            },
            notes: {
              type: 'string',
              description: '備註說明，可為空字串'
            }
          },
          required: ['ridePeriod', 'rideDate', 'rideType', 'rideRows', 'totalFare']
        }
      }
    }
  },

  laptop: {
    id: 'laptop',
    label: '筆電申請單',
    urlPattern: 'XZF0_0450/prompt',
    urlContains: '685219a0fbb2b7651dbc0ffc',
    instructions: `你是筆電申請單助理。用繁體中文引導使用者完成筆電申請。
回覆簡短扼要，每次不超過兩句。

必填欄位：
1. 需求類型（可複選）：需外接特殊設備、設計/影片剪輯、海外出差、高資源軟體、以上皆無
2. 是否申請者本人使用（是/否）
3. 使用者姓名
4. 申請方案（標準/進階/高階）

重要規則：
- fill_form 的 key 必須用中文欄位名，對應表單上的欄位標籤
- 需求類型是 checkbox，值用逗號分隔
- 使用者一次說完所有必填資訊才可以直接填，不需逐一確認
- 不可自行編造使用者沒提供的姓名、需求或方案
- 缺少資訊務必追問，全部完整才能呼叫 fill_form`,
    toolSchema: {
      type: 'function',
      function: {
        name: 'fill_form',
        description: '當所有必填欄位完整時，填入筆電申請單。key 必須使用中文欄位名稱以對應表單標籤。',
        parameters: {
          type: 'object',
          properties: {
            '需求類型': {
              type: 'array',
              items: {
                type: 'string',
                enum: ['需外接特殊設備', '設計/影片剪輯', '海外出差', '高資源軟體', '以上皆無']
              },
              description: '需求類型（可複選）'
            },
            '是否本人使用': {
              type: 'string',
              enum: ['是', '否'],
              description: '是否申請者本人使用'
            },
            '使用者姓名': {
              type: 'string',
              description: '使用者姓名'
            },
            '申請方案': {
              type: 'string',
              enum: ['標準', '進階', '高階'],
              description: '申請方案'
            }
          },
          required: ['需求類型', '是否本人使用', '使用者姓名', '申請方案']
        }
      }
    }
  },

  it_request: {
    id: 'it_request',
    label: '資訊作業申請',
    urlPattern: 'XZF0_0450/prompt',
    urlContains: '6886d10efbb2b7284c267690',
    instructions: `你是資訊作業申請單助理。用繁體中文引導使用者完成申請。
回覆簡短扼要，每次不超過兩句。

必填欄位：
1. 申請者（姓名，純文字）
2. 作業原因（純文字描述，例：「系統維護」「資料備份」）
3. 需求說明（純文字描述，詳細說明需要做什麼）
4. 申請起始時間及終止時間（純文字，例：「2026-05-15 09:00-12:00」或「週一上午」）
5. 作業人員（姓名，純文字）

重要規則：
- fill_form 的 key 必須用中文欄位名（申請者、作業原因、需求說明、申請起始時間及終止時間、作業人員）
- 所有欄位都是純文字輸入，直接填入使用者說的內容即可
- 使用者一次說完所有必填資訊才可以直接填，不需逐一確認
- 不可自行編造使用者沒提供的姓名、作業原因、需求、時間或作業人員
- 不要拒絕填寫文字型欄位，使用者提供什麼就填什麼
- 缺少資訊務必追問，全部完整才能呼叫 fill_form`,
    toolSchema: {
      type: 'function',
      function: {
        name: 'fill_form',
        description: '當所有必填欄位完整時，填入資訊作業申請單。key 必須使用中文欄位名稱以對應表單標籤。',
        parameters: {
          type: 'object',
          properties: {
            '申請者': { type: 'string', description: '申請者姓名' },
            '作業原因': { type: 'string', description: '作業原因' },
            '需求說明': { type: 'string', description: '需求說明' },
            '申請起始時間及終止時間': { type: 'string', description: '申請起始時間及終止時間' },
            '作業人員': { type: 'string', description: '作業人員' }
          },
          required: ['申請者', '作業原因', '需求說明', '申請起始時間及終止時間', '作業人員']
        }
      }
    }
  }
};

// Match current page URL to a known form schema
function matchFormSchema(url) {
  for (const schema of Object.values(FORM_SCHEMAS)) {
    if (schema.urlContains && url.includes(schema.urlContains)) {
      return schema;
    }
  }
  // Fallback: no known schema
  return null;
}
