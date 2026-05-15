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
- 使用者一次把資訊說完就直接填，不需要逐一確認
- 日期格式必須是 YYYY-MM-DD（例：今天是2026-05-15）
- 費用必須是純數字字串
- 車資合計 = 所有趟次的 fee 加總，你可以自己算不需要問使用者
- 乘車時段沒提到就預設 01_平日(08~21)
- 來回就是 02_單日來回，兩筆 rideRows（去程跟回程）
- 如果使用者說「來回」且每趟150，就自動產生兩筆 rideRows 並算合計300
- 使用者說「確認沒問題幫我送出」這類話表示所有資訊都說完了，直接呼叫 fill_form`,
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

缺少資訊務必追問，全部完整才能呼叫 fill_form。`,
    toolSchema: {
      type: 'function',
      function: {
        name: 'fill_form',
        description: '當所有必填欄位完整時，填入筆電申請單。',
        parameters: {
          type: 'object',
          properties: {
            needs: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['external_device', 'design_video', 'overseas', 'high_resource', 'none']
              },
              description: '需求類型：external_device=外接設備、design_video=設計/剪輯、overseas=海外出差、high_resource=高資源、none=皆無'
            },
            applicantIsUser: {
              type: 'string',
              enum: ['yes', 'no'],
              description: '是否本人使用：yes=是、no=代他人'
            },
            name: {
              type: 'string',
              description: '使用者姓名'
            },
            plan: {
              type: 'string',
              enum: ['standard', 'advanced', 'high'],
              description: '申請方案'
            }
          },
          required: ['needs', 'applicantIsUser', 'name', 'plan']
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
1. 申請者姓名
2. 申請原因
3. 需求說明
4. 作業時段
5. 作業人員

缺少資訊務必追問，全部完整才能呼叫 fill_form。`,
    toolSchema: {
      type: 'function',
      function: {
        name: 'fill_form',
        description: '當所有必填欄位完整時，填入資訊作業申請單。',
        parameters: {
          type: 'object',
          properties: {
            applicant: { type: 'string', description: '申請者姓名' },
            reason: { type: 'string', description: '申請原因' },
            requirement: { type: 'string', description: '需求說明' },
            timeSlot: { type: 'string', description: '作業時段' },
            operator: { type: 'string', description: '作業人員' }
          },
          required: ['applicant', 'reason', 'requirement', 'timeSlot', 'operator']
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
