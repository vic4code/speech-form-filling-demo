// Client-side guardrail - keyword pattern matching for content safety
// Mirrors app/guardrails.py from the backend

const BLOCK_PATTERNS = [
  {
    category: 'Prompt injection',
    pattern: /(忽略|無視|无视|跳過|跳过|覆蓋|覆盖|override).{0,6}(指令|instructions|prompt|規則|规则|設定|设定)|ignore.{0,10}(previous|above|prior|system)|jailbreak|DAN|do anything now|角色劫持|扮演.{0,4}(壞人|坏人|駭客|黑客|惡意|恶意)/i
  },
  {
    category: 'Data exfiltration',
    pattern: /(列出|顯示|显示|給我|给我).{0,6}(所有|全部).{0,6}(使用者|用戶|用户|帳號|账号|密碼|密码|資料|资料)|(API|api).?key|access.?token|密[碼码]是什[麼么]/i
  },
  {
    category: 'Abuse',
    pattern: /[幹干]你[娘媽妈妹]|操你[媽妈妹爸]|去死|王八蛋|狗娘養|狗娘养|[他她]媽的|[他她]妈的|靠北|機掰|机掰|傻[逼比]|混蛋|[滾滚]蛋|白癡|白痴|fuck\s*you|shit|bitch|asshole|kill\s*yourself|去你的|妈的|媽的/i
  },
  {
    category: 'Violence',
    pattern: /(做|製作|制作|製造|制造|組裝|组装).{0,4}(炸[彈弹]|炸[藥药]|武器|[槍枪]|毒品)|(搶劫|抢劫|綁架|绑架|殺[人了掉]|杀[人了掉]|暗殺|暗杀|放火|縱火|纵火|強暴|强暴|販毒|贩毒|走私)/i
  },
  {
    category: 'Expense fraud',
    pattern: /(多報|多报|虛報|虚报|灌水|偽造|伪造|竄改|篡改).{0,4}(金額|金额|費用|费用|發票|发票|收據|收据)|不要留.{0,4}[紀纪記记][錄录]|假[發发]票|假收[據据]/i
  },
  {
    category: 'Code injection',
    pattern: /DROP\s+TABLE|<script|UNION\s+SELECT|1\s*=\s*1|eval\s*\(|exec\s*\(/i
  }
];

function checkGuardrail(text) {
  if (!text || !text.trim()) return { passed: true, reason: '' };

  for (const { category, pattern } of BLOCK_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return { passed: false, reason: category, matched: match[0] };
    }
  }
  return { passed: true, reason: '' };
}
