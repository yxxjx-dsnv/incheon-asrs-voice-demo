import { interpret, josa, CATALOG } from './AsrsVoiceDemo';

const shampoo = CATALOG.find((i) => i.name === '세차 샴푸')!;

test('hears products by keyword, and never guesses', () => {
  expect(interpret('세차 샴푸 가져와 줘')).toEqual({ kind: 'ask', items: [shampoo] });
  const many = interpret('극세사 타월이랑 유리 세정제, 12볼트 리튬 배터리도');
  expect(many.kind === 'ask' && many.items.map((i) => i.bin)).toEqual([4, 8, 13]);
  expect(interpret('응 가져와')).toEqual({ kind: 'miss' }); // a yes alone orders nothing
  expect(interpret('오늘 날씨 어때')).toEqual({ kind: 'miss' });
});

test('josa follows the final consonant', () => {
  expect(josa('세차 샴푸', '을', '를')).toBe('세차 샴푸를');
  expect(josa('극세사 타월', '을', '를')).toBe('극세사 타월을');
  expect(josa('유리 세정제', '이', '가')).toBe('유리 세정제가');
});

test('every keyword fetches exactly one product', () => {
  for (const item of CATALOG)
    for (const key of item.keys) {
      const hit = interpret(key);
      expect(hit.kind === 'ask' && hit.items).toEqual([item]); // no word pulls two bins
    }
});
