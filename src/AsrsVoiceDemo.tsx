import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import type { Fleet, Phase } from './asrsFleet';

// DEV only (AsrsSim loads it behind import.meta.env.DEV + ?voice): the ASRS kiosk, mocked
// over the fleet sim for the application video.
//
// The chrome copies the real kiosk (io_system_ui): its dark palette, its status bar, its
// product cards and its floating 음성 어시스턴트 window, down to the Korean strings in
// io_system_ui/src/i18n.ts. What it does NOT copy is the pipeline behind it — the real
// window sends the clip to io_voice_interface (Whisper → LLM → world model → ROS), while
// this one listens with the browser's own ko-KR engine and matches the products printed on
// the bins. It keeps the part that matters: read the order back, move only on Confirm,
// ask again rather than guess.

export type Item = { name: string; bin: number; keys: string[]; qty: number };

/** What each bin holds — the labels the sim prints on them, and the words that fetch them. */
export const CATALOG: Item[] = [
  { name: '물왁스', bin: 0, keys: ['물왁스', '왁스'], qty: 12 },
  { name: '세차 샴푸', bin: 1, keys: ['샴푸'], qty: 20 },
  { name: '휠 클리너', bin: 2, keys: ['클리너'], qty: 8 },
  { name: '발수 코팅제', bin: 3, keys: ['코팅'], qty: 6 },
  { name: '극세사 타월', bin: 4, keys: ['타월', '타올', '수건'], qty: 40 },
  { name: '워시 미트', bin: 5, keys: ['미트', '워시'], qty: 15 },
  { name: '휠 브러시', bin: 6, keys: ['브러시', '브러쉬'], qty: 18 },
  { name: '실내 방향제', bin: 7, keys: ['방향제'], qty: 24 },
  { name: '유리 세정제', bin: 8, keys: ['세정제', '유리'], qty: 10 },
  { name: '에어건 필터', bin: 9, keys: ['필터', '에어건'], qty: 9 },
  { name: '세차 스펀지', bin: 10, keys: ['스펀지', '스폰지'], qty: 30 },
  { name: '타이어 광택제', bin: 11, keys: ['광택', '타이어'], qty: 14 },
  { name: '세차 버킷', bin: 12, keys: ['버킷', '양동이'], qty: 7 },
  { name: '12V 리튬 배터리', bin: 13, keys: ['배터리', '밧데리', '리튬'], qty: 11 },
];
/** B01… — the number printed on the bin, one-based so it reads like a label, not an index. */
export const binNo = (bin: number) => `B${String(bin + 1).padStart(2, '0')}`;

export type Intent = { kind: 'ask'; items: Item[] } | { kind: 'miss' };

/** Products heard in what the operator said. Nothing recognised is a miss, never a guess. */
export function interpret(text: string): Intent {
  const t = text.replace(/\s+/g, '');
  const items = CATALOG.filter((it) => it.keys.some((k) => t.includes(k)));
  return items.length ? { kind: 'ask', items } : { kind: 'miss' };
}

/** 을/를, 이/가 — by whether the last syllable has a final consonant. */
export const josa = (w: string, withFinal: string, without: string) => {
  const c = w.charCodeAt(w.length - 1) - 0xac00;
  return w + (c >= 0 && c <= 11171 && c % 28 !== 0 ? withFinal : without);
};

const list = (items: Item[]) => items.map((i) => i.name).join(', ');

const STAGE: Record<Phase, string> = {
  idle: '대기',
  toBin: '빈으로 이동',
  spread: '빈 잡는 중',
  liftUp: '들어 올리는 중',
  lock: '고정',
  toLift: '엘리베이터로 이동',
  waitLift: '엘리베이터 호출',
  holdLift: '엘리베이터 대기',
  board: '엘리베이터 탑승',
  riding: '엘리베이터 이동',
  toStation: '스테이션으로 운반',
  present: '내려놓는 중',
  toShelf: '제자리로 반납',
  unlock: '내려놓는 중',
  setDown: '내려놓는 중',
  stow: '정리',
};

// the kiosk's own dark palette (io_system_ui/src/theme.tsx)
const BG = '#242424';
const PAPER = '#1e2a38';
const TEXT2 = '#a0b4c8';
const BLUE = '#2571af';

type Order = { item: Item; arrived: boolean; station: number; status: string; done: boolean };
type Bubble = {
  id: number;
  role: 'operator' | 'assistant';
  text: string;
  pending?: Item[];
  note?: string;
  status?: 'confirmed' | 'cancelled';
};

// the slice of the Web Speech API used here (not in lib.dom for every TS target)
type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

export default function AsrsVoiceDemo({ fleetRef }: { fleetRef: MutableRefObject<Fleet | null> }) {
  const [open, setOpen] = useState(true);
  const [phase, setPhase] = useState<'idle' | 'listening' | 'thinking'>('idle');
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState('');
  const recRef = useRef<Rec | null>(null);
  const stopMeter = useRef<(() => void) | null>(null);
  const ordersRef = useRef<Order[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  const push = (b: Omit<Bubble, 'id'>) => {
    const bubble = { ...b, id: nextId.current++ };
    setBubbles((bs) => [...bs.slice(-8), bubble]);
    return bubble.id;
  };
  const patch = (id: number, change: Partial<Bubble>) =>
    setBubbles((bs) => bs.map((b) => (b.id === id ? { ...b, ...change } : b)));

  const say = (text: string) => {
    const u = new SpeechSynthesisUtterance(text.replace(/(\d+)V/g, '$1볼트')); // "12V" read aloud as 12볼트
    u.lang = 'ko-KR';
    const v = speechSynthesis.getVoices().find((x) => x.lang.startsWith('ko'));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [bubbles, phase]);

  // ── the microphone: one ko-KR utterance per tap, the way the kiosk records one clip ──
  const heard = (text: string) => {
    setPhase('thinking'); // the kiosk shows this while the service transcribes and interprets
    setTimeout(() => {
      setPhase('idle');
      push({ role: 'operator', text });
      const intent = interpret(text);
      if (intent.kind === 'miss') {
        const miss = '잘 못 알아들었습니다. 다시 말씀해 주세요.';
        push({ role: 'assistant', text: miss });
        return say(miss);
      }
      const out = intent.items.filter((i) => ordersRef.current.some((o) => o.item === i && !o.done));
      const fresh = intent.items.filter((i) => !out.includes(i));
      if (!fresh.length) {
        const already = `${josa(list(out), '은', '는')} 이미 나와 있습니다.`;
        push({ role: 'assistant', text: already });
        return say(already);
      }
      const ask =
        fresh.length === 1
          ? `${fresh[0].name} — ${fresh[0].bin + 1}번 빈을 1번 스테이션으로 가져올까요?`
          : `${josa(list(fresh), '을', '를')} 로봇 ${fresh.length}대로 가져올까요?`;
      push({ role: 'assistant', text: ask, pending: fresh });
      say(ask);
    }, 450);
  };
  const heardRef = useRef(heard);
  heardRef.current = heard;

  const stopListening = () => {
    recRef.current?.stop();
    recRef.current = null;
    stopMeter.current?.();
    stopMeter.current = null;
    setLevel(0);
    setPhase((p) => (p === 'listening' ? 'idle' : p));
  };

  const startListening = () => {
    const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) return setErr('이 브라우저는 음성 인식을 지원하지 않습니다. Chrome에서 열어 주세요.');
    setErr('');
    const rec = new SR();
    recRef.current = rec;
    rec.lang = 'ko-KR';
    rec.continuous = false;
    rec.interimResults = true;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!r.isFinal) continue;
        const text = r[0].transcript.trim();
        stopListening();
        if (text) heardRef.current(text);
      }
    };
    rec.onerror = (e) => {
      stopListening();
      if (e.error === 'not-allowed') setErr('마이크 권한이 거부되었습니다.');
    };
    rec.onend = () => setPhase((p) => (p === 'listening' ? 'idle' : p));
    rec.start();
    setPhase('listening');

    // the level meter: the kiosk pulses its button with measured loudness, so it is
    // visible that the microphone is live rather than merely switched on
    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((stream) => {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        let raf = 0;
        const tick = () => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          setLevel(Math.sqrt(sum / buf.length));
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        stopMeter.current = () => {
          cancelAnimationFrame(raf);
          stream.getTracks().forEach((t) => t.stop());
          void ctx.close();
        };
      })
      .catch(() => undefined);
  };

  useEffect(() => stopListening, []); // stop the mic when the demo unmounts
  // eslint-disable-next-line react-hooks/exhaustive-deps

  const resolve = (bubble: Bubble, go: boolean) => {
    const fleet = fleetRef.current;
    if (!go || !fleet) {
      patch(bubble.id, { pending: undefined, status: 'cancelled' });
      return say('취소되었습니다.');
    }
    const sent = (bubble.pending ?? []).filter((i) => fleet.request(i.bin));
    ordersRef.current = [
      ...ordersRef.current.filter((o) => !o.done),
      ...sent.map((item) => ({ item, arrived: false, station: 0, status: '대기', done: false })),
    ];
    setOrders(ordersRef.current);
    const note = sent.length ? '로봇에 전달했습니다.' : '지금은 가져올 수 없습니다.';
    patch(bubble.id, { pending: undefined, status: sent.length ? 'confirmed' : 'cancelled', note });
    say(note);
  };

  // follow each order through the fleet — carried, waiting on the station, or back home
  useEffect(() => {
    const id = setInterval(() => {
      const fleet = fleetRef.current;
      if (!fleet || !ordersRef.current.length) return;
      let changed = false;
      ordersRef.current = ordersRef.current.map((o) => {
        if (o.done) return o;
        const r = fleet.robots.find((x) => x.binId === o.item.bin);
        const b = fleet.bins.find((x) => x.id === o.item.bin);
        let { arrived, station, status } = o;
        let done = false; // o.done is narrowed to false above
        if (r) {
          if (r.phase === 'present' && !arrived) {
            arrived = true;
            station = r.station + 1;
            const line = `${josa(o.item.name, '이', '가')} ${station}번 스테이션에 도착했습니다.`;
            push({ role: 'assistant', text: line });
            say(line);
          }
          status = `R0${r.id + 1} · ${STAGE[r.phase]}`;
        } else if (b?.cell && fleet.atStation(b.cell)) {
          status = `${station}번 스테이션 · 피킹 대기`;
        } else if (arrived) {
          done = true;
          status = '반납 완료';
        }
        if (arrived === o.arrived && status === o.status && done === o.done) return o;
        changed = true;
        return { ...o, arrived, station, status, done };
      });
      if (changed) setOrders(ordersRef.current);
    }, 200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const font = 'Inter, Pretendard, system-ui, sans-serif';
  const card: CSSProperties = {
    background: PAPER,
    border: '1px solid #33455a',
    borderRadius: 8,
    padding: '5px 8px',
    fontSize: 12.5,
    lineHeight: 1.3,
  };
  const bar: CSSProperties = {
    position: 'absolute',
    inset: '0 0 auto 0',
    height: 56,
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '0 16px',
    background: BG,
    borderBottom: '1px solid #33455a',
    color: '#fff',
    font: `600 14px ${font}`,
  };
  const tab = (active: boolean): CSSProperties => ({
    padding: '6px 10px',
    fontSize: 12,
    letterSpacing: '0.1em',
    color: active ? '#fff' : TEXT2,
    borderBottom: active ? '2px solid #fff' : '2px solid transparent',
  });

  return (
    <>
      {/* the kiosk's status bar */}
      <div style={bar}>
        <span style={{ width: 26, height: 26, borderRadius: 6, background: BLUE, display: 'grid', placeItems: 'center', fontSize: 13 }}>io</span>
        <span style={{ lineHeight: 1 }}>
          <span style={{ display: 'block', fontSize: 9, letterSpacing: '0.18em', color: TEXT2 }}>CURRENT STATE</span>
          <span style={{ fontSize: 17, letterSpacing: '0.08em' }}>RUNNING</span>
        </span>
        <span style={{ background: '#c8cf3a', color: '#1a1a1a', padding: '6px 14px', borderRadius: 4, fontSize: 13 }}>STOP</span>
        <span style={{ background: '#e5393c', color: '#fff', padding: '6px 14px', borderRadius: 4, fontSize: 13 }}>EMERGENCY</span>
        <span style={{ color: '#5c6b7a', border: '1px solid #33455a', padding: '6px 14px', borderRadius: 4, fontSize: 13 }}>EDIT MAP</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <span style={tab(false)}>MAP</span>
          <span style={tab(true)}>INCOMING</span>
          <span style={tab(false)}>SETTINGS</span>
        </span>
      </div>

      {/* the products the warehouse is holding, as kiosk cards */}
      <div
        style={{
          position: 'absolute',
          top: 68,
          right: 12,
          width: 290,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 6,
          color: '#fff',
          fontFamily: font,
        }}
      >
        {CATALOG.map((it) => {
          const o = orders.find((x) => x.item === it && !x.done);
          return (
            <div
              key={it.bin}
              style={{
                ...card,
                background: o ? '#f5e061' : PAPER,
                color: o ? '#1a1a1a' : '#fff',
                borderColor: o ? '#f5e061' : '#33455a',
              }}
            >
              <span style={{ fontSize: 10, letterSpacing: '0.08em', opacity: 0.65, marginRight: 5 }}>{binNo(it.bin)}</span>
              {it.name}
              <span style={{ opacity: 0.7 }}> ({it.qty})</span>
            </div>
          );
        })}
      </div>

      {/* what the robots are doing with the orders */}
      {orders.length > 0 && (
        <div style={{ position: 'absolute', left: 12, bottom: 12, minWidth: 320, color: '#fff', fontFamily: font, ...card }}>
          <div style={{ color: TEXT2, fontSize: 11, letterSpacing: '0.08em', marginBottom: 6 }}>작업 목록</div>
          {orders.map((o) => (
            <div key={o.item.bin} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '2px 0', opacity: o.done ? 0.5 : 1 }}>
              <span>
                <span style={{ color: TEXT2, fontSize: 11, marginRight: 6 }}>{binNo(o.item.bin)}</span>
                {o.item.name}
              </span>
              <span style={{ color: o.arrived && !o.done ? '#7ee29a' : '#9fc3ff' }}>{o.status}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ position: 'absolute', left: 12, bottom: orders.length ? 130 : 12, color: TEXT2, fontFamily: font, fontSize: 11, letterSpacing: '0.06em' }}>
        3D 시뮬레이션 · 음성 명령 프로토타입
      </div>

      {/* the floating 음성 어시스턴트 window */}
      {open ? (
        <div
          style={{
            position: 'absolute',
            right: 24,
            bottom: 24,
            width: 420,
            maxHeight: 'min(560px, calc(100% - 120px))',
            display: 'flex',
            flexDirection: 'column',
            background: PAPER,
            border: '1px solid #33455a',
            borderRadius: 10,
            boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
            color: '#fff',
            fontFamily: font,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #33455a', fontSize: 13, color: TEXT2 }}>
            음성 어시스턴트
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: TEXT2, fontSize: 16, cursor: 'pointer' }}
            >
              ×
            </button>
          </div>

          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 120 }}>
            {!bubbles.length && (
              <div style={{ color: '#6f8296', textAlign: 'center', marginTop: 24, fontSize: 14, lineHeight: 1.7 }}>
                마이크를 누르고 명령을 말하세요.
                <br />
                예시: &ldquo;세차 샴푸 가져와&rdquo;
              </div>
            )}
            {bubbles.map((b) => (
              <div key={b.id} style={{ display: 'flex', justifyContent: b.role === 'operator' ? 'flex-end' : 'flex-start' }}>
                <div
                  style={{
                    maxWidth: '85%',
                    padding: '10px 12px',
                    borderRadius: 10,
                    fontSize: 14,
                    lineHeight: 1.5,
                    background: b.role === 'operator' ? '#ffffff' : '#25334455',
                    color: b.role === 'operator' ? '#1a1a1a' : '#fff',
                    border: b.role === 'operator' ? 'none' : '1px solid #33455a',
                  }}
                >
                  {b.text}
                  {b.pending && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button
                        type="button"
                        onClick={() => resolve(b, true)}
                        style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 4, padding: '6px 14px', fontSize: 13, cursor: 'pointer' }}
                      >
                        확인
                      </button>
                      <button
                        type="button"
                        onClick={() => resolve(b, false)}
                        style={{ background: 'none', color: '#fff', border: '1px solid #4a5f75', borderRadius: 4, padding: '6px 14px', fontSize: 13, cursor: 'pointer' }}
                      >
                        취소
                      </button>
                    </div>
                  )}
                  {b.note && <div style={{ color: TEXT2, fontSize: 12.5, marginTop: 6 }}>{b.note}</div>}
                  {b.status && (
                    <div
                      style={{
                        display: 'inline-block',
                        marginTop: 8,
                        padding: '2px 10px',
                        borderRadius: 999,
                        fontSize: 11.5,
                        background: b.status === 'confirmed' ? '#2e7d32' : '#3a4a5c',
                        color: '#fff',
                      }}
                    >
                      {b.status === 'confirmed' ? '확인됨' : '취소됨'}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {phase === 'thinking' && <div style={{ color: TEXT2, fontSize: 13 }}>생각 중…</div>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '10px 14px 16px' }}>
            {err && <div style={{ color: '#ff8a8a', fontSize: 12.5, textAlign: 'center' }}>{err}</div>}
            <div style={{ width: 200, height: 3, background: '#33455a', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, level * 400)}%`, height: '100%', background: phase === 'listening' ? '#e5393c' : BLUE, transition: 'width 80ms linear' }} />
            </div>
            <button
              type="button"
              onClick={phase === 'listening' ? stopListening : startListening}
              disabled={phase === 'thinking'}
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                border: 'none',
                cursor: 'pointer',
                fontSize: 22,
                background: phase === 'listening' ? '#e5393c' : '#ffffff',
                color: phase === 'listening' ? '#fff' : '#1a1a1a',
                transform: phase === 'listening' ? `scale(${1 + Math.min(level * 4, 0.35)})` : 'none',
                transition: 'transform 80ms linear',
              }}
              aria-label={phase === 'listening' ? '중지' : '눌러서 말하기'}
            >
              {phase === 'listening' ? '■' : '🎙'}
            </button>
            <div style={{ color: TEXT2, fontSize: 12 }}>
              {phase === 'listening' ? '듣는 중… 누르면 중지됩니다' : '눌러서 말하기'}
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{ position: 'absolute', right: 24, bottom: 24, width: 56, height: 56, borderRadius: '50%', border: 'none', background: '#fff', fontSize: 22, cursor: 'pointer' }}
          aria-label="음성 어시스턴트 열기"
        >
          🎙
        </button>
      )}
    </>
  );
}
