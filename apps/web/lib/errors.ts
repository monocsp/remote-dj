/** Map known server ack error strings to friendly Korean messages. */
const ERROR_MESSAGES: Record<string, string> = {
  'reason required': '사유를 입력해 주세요',
  'invalid youtube url': '유효한 YouTube 링크가 아니에요',
  'embed disabled': '임베드(퍼가기)가 막힌 영상이라 재생할 수 없어요',
  'input too long': '입력이 너무 길어요',
  'wrong password': '비밀번호가 올바르지 않습니다',
  'nickname required': '닉네임이 있어야 곡을 변경할 수 있어요',
  'invalid index': '잘못된 항목이에요',
  'not your item': '내가 추가한 곡만 삭제할 수 있어요',
  'invalid seconds': '잘못된 위치예요',
  'invalid code': '잘못된 방 코드예요',
  'player only': 'Player만 할 수 있는 동작이에요',
  'controllers only': 'Controller만 할 수 있는 동작이에요',
  'not connected': '연결이 끊겼어요. 다시 시도해 주세요',
};

/** Return a Korean message for a server ack error, falling back to the original. */
export function koError(err?: string): string {
  if (!err) return '요청을 처리하지 못했어요';
  return ERROR_MESSAGES[err] ?? err;
}
