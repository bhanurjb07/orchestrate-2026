'use strict';
// Does the request text authorize deletion? Negations are checked first, then deletion phrasing.
// Anything the rules cannot decide is "unclear"; the caller must not treat it as a deletion.

const NEGATIVE = [
  /\bnot\s+(asking|requesting|a request)\s+(for|to)\s+(deletion|delet|eras)/i,
  /\b(don'?t|do not|never)\s+(delete|close|remove|erase)/i,
  /\bwithout\s+(removing|deleting)/i,
  /\bleave\s+(the|my)\s+(account|profile)[^.]*\b(active|in place|as it is)/i,
  /\bkeep\s+the\s+account\s+as\s+it\s+is/i,
  /\bmarketing\s+lists?\s+only\b/i,
  /\bcontinue\s+using\s+the\s+service/i,
  /\binformation\s+request\b/i,
  /\bstill\s+(need|use|want)\s+(the|my|it)\b/i,
  /\b(send|give|provide)\s+me\s+(a\s+)?copy\b/i,
  /\bkeep\s+using\s+(my|the|this)\s+account\b/i,
];

const POSITIVE = [
  /\b(delet|eras|remov)\w*/i,
  /\bclose\s+(my|this|the)\s+account/i,
  /\bclosed?\s+my\s+account/i,
  /\b(profile|account)\s+is\s+gone\b|\bcannot\s+identify\s+me\b/i,
  /suppression|eliminaci[oó]n|exclus[aã]o|l[oö]sch|cancellazione/i,
  /삭제|削除|删除|注销/,
];

const SUBJECT = /\b(account|profile|personal|data|record|identity|export|search result|archive)\b|compte|cuenta|conta|konto|daten|계정|アカウント|账户/i;

function classifyRequest(text) {
  const t = String(text || '');
  if (NEGATIVE.some(re => re.test(t))) return { decision: 'NOT_DELETION', reason: 'negative pattern' };
  if (POSITIVE.some(re => re.test(t)) && SUBJECT.test(t)) return { decision: 'DELETION', reason: 'deletion pattern' };
  return { decision: 'UNCLEAR', reason: 'no rule matched' };
}

module.exports = { classifyRequest };
