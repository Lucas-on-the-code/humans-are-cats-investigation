import { useState } from 'react';
import { useI18n } from '../i18n';

type Step = 'q1' | 'q2' | 'q3' | 'q4' | 'emailWilling' | 'emailPass' | 'done';
type Status = 'success' | 'registered' | 'invalidEmail' | 'networkError' | null;

interface Props {
  userId: string | null;
  guestId: string;
  onComplete: () => void;
  onDismiss: () => void;
}

const PROGRESS_STEPS: Step[] = ['q1', 'q2', 'q3'];

export const SurveyPopup = ({ userId, guestId, onComplete, onDismiss }: Props) => {
  const { t, locale } = useI18n();
  const [step, setStep] = useState<Step>('q1');
  const [q1, setQ1] = useState<string | null>(null);
  const [q2, setQ2] = useState<string[]>([]);
  const [q2Other, setQ2Other] = useState('');
  const [q2OtherOn, setQ2OtherOn] = useState(false);
  const [q3, setQ3] = useState<'yes' | 'maybe' | 'nah' | null>(null);
  const [q4, setQ4] = useState<string[]>([]);
  const [q4Other, setQ4Other] = useState('');
  const [q4OtherOn, setQ4OtherOn] = useState(false);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [submitting, setSubmitting] = useState(false);

  const toggleMulti = (arr: string[], setArr: (v: string[]) => void, value: string) => {
    setArr(arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]);
  };

  const submit = async (override: { reachedEmail: number; email?: string | null }) => {
    setSubmitting(true);
    setStatus(null);
    try {
      const res = await fetch('/api/survey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId, guestId,
          q1, q2, q3, q4,
          q2Other: q2OtherOn ? q2Other : undefined,
          q4Other: q4OtherOn ? q4Other : undefined,
          email: override.email ?? null,
          reachedEmail: override.reachedEmail,
          locale,
        }),
      });
      const data = await res.json().catch(() => ({ ok: false }));
      if (res.ok && data.ok) {
        setStatus('success');
        onComplete();
        return;
      }
      if (data.error === 'EMAIL_INVALID') { setStatus('invalidEmail'); return; }
      if (data.error === 'EMAIL_ALREADY_REGISTERED') { setStatus('registered'); onComplete(); return; }
      setStatus('networkError');
    } catch {
      setStatus('networkError');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    // 中途关闭：有答案则落部分数据
    if (q1 || q2.length || q3 || q4.length) {
      void submit({ reachedEmail: 0 });
    }
    onDismiss();
  };

  const progressIndex = PROGRESS_STEPS.indexOf(step);
  const progressTotal = PROGRESS_STEPS.length;
  const isEmailStep = step === 'emailWilling' || step === 'emailPass';

  return (
    <div className="absolute right-4 top-4 md:right-6 md:top-6 z-50 w-[min(92vw,24rem)] game-panel rounded-lg p-4 text-left max-h-[88vh] overflow-y-auto bottom-4 md:bottom-auto inset-x-4 md:inset-x-auto">
      <div className="flex items-center justify-between mb-3">
        {!isEmailStep && (
          <div className="flex gap-1" aria-label={t('survey.aria.progress', { n: Math.max(1, progressIndex + 1), total: progressTotal })}>
            {PROGRESS_STEPS.map((_, i) => (
              <span key={i} className={`w-2 h-2 rounded-full ${i <= progressIndex ? 'bg-cyan-400' : 'bg-slate-600'}`} />
            ))}
          </div>
        )}
        {isEmailStep && <span className="text-xs text-cyan-200/70">✦</span>}
        <button onClick={handleClose} className="text-slate-400 hover:text-white text-xl leading-none" aria-label="close">×</button>
      </div>

      {step === 'q1' && (
        <div className="space-y-3">
          <p className="text-cyan-100 text-sm whitespace-pre-line">{t('survey.lead') + '\n' + t('survey.leadSub')}</p>
          <p className="text-white font-bold text-sm">{t('survey.q1.label')}</p>
          {[1, 2, 3, 4].map((i) => (
            <button key={i} onClick={() => setQ1(t(`survey.q1.opt${i}`))}
              className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${q1 === t(`survey.q1.opt${i}`) ? 'bg-cyan-500/30 text-cyan-50 ring-1 ring-cyan-400' : 'bg-slate-800/60 text-slate-200 hover:bg-slate-700/60'}`}>
              {t(`survey.q1.opt${i}`)}
            </button>
          ))}
          <div className="flex justify-end gap-2 pt-1">
            <button disabled={!q1 || submitting} onClick={() => setStep('q2')}
              className="px-4 py-2 game-button text-white text-sm rounded-md disabled:opacity-40">{t('survey.next')}</button>
          </div>
        </div>
      )}

      {step === 'q2' && (
        <div className="space-y-2">
          <p className="text-white font-bold text-sm">{t('survey.q2.label')}</p>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
            <label key={i} className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer ${q2.includes(t(`survey.q2.opt${i}`)) ? 'bg-cyan-500/20 ring-1 ring-cyan-400/60' : 'bg-slate-800/60 hover:bg-slate-700/60'}`}>
              <input type="checkbox" checked={q2.includes(t(`survey.q2.opt${i}`))} onChange={() => toggleMulti(q2, setQ2, t(`survey.q2.opt${i}`))} className="accent-cyan-400" />
              <span className="text-slate-200">{t(`survey.q2.opt${i}`)}</span>
            </label>
          ))}
          <label className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer ${q2OtherOn ? 'bg-cyan-500/20 ring-1 ring-cyan-400/60' : 'bg-slate-800/60 hover:bg-slate-700/60'}`}>
            <input type="checkbox" checked={q2OtherOn} onChange={() => setQ2OtherOn(!q2OtherOn)} className="accent-cyan-400" />
            <span className="text-slate-200">{t('survey.q2.other')}</span>
          </label>
          {q2OtherOn && (
            <textarea value={q2Other} onChange={(e) => setQ2Other(e.target.value)} placeholder={t('survey.q2.otherPh')}
              className="w-full bg-slate-900/70 border border-slate-700 rounded-md px-2 py-1 text-sm text-slate-100" rows={2} maxLength={400} />
          )}
          <div className="flex justify-between gap-2 pt-1">
            <button onClick={() => setStep('q1')} className="px-3 py-2 game-button-secondary text-sm rounded-md">{t('survey.back')}</button>
            <button disabled={submitting} onClick={() => setStep('q3')} className="px-4 py-2 game-button text-white text-sm rounded-md disabled:opacity-40">{t('survey.next')}</button>
          </div>
        </div>
      )}

      {step === 'q3' && (
        <div className="space-y-3">
          <p className="text-cyan-50 text-sm whitespace-pre-line leading-relaxed">{t('survey.q3.body')}</p>
          <div className="flex justify-between gap-2 pt-1">
            <button onClick={() => setStep('q2')} className="px-3 py-2 game-button-secondary text-sm rounded-md">{t('survey.back')}</button>
            <div className="flex gap-2">
              <button disabled={submitting} onClick={() => { setQ3('nah'); setStep('q4'); }} className="px-3 py-2 game-button-secondary text-sm rounded-md">{t('survey.q3.nah')}</button>
              <button disabled={submitting} onClick={() => { setQ3('maybe'); setStep('emailWilling'); }} className="px-3 py-2 game-button text-white text-sm rounded-md">{t('survey.q3.maybe')}</button>
              <button disabled={submitting} onClick={() => { setQ3('yes'); setStep('emailWilling'); }} className="px-3 py-2 game-button text-white text-sm rounded-md">{t('survey.q3.yes')}</button>
            </div>
          </div>
        </div>
      )}

      {step === 'q4' && (
        <div className="space-y-2">
          <p className="text-white font-bold text-sm">{t('survey.q4.label')}</p>
          {[1, 2, 3, 4, 5, 6, 7].map((i) => (
            <label key={i} className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer ${q4.includes(t(`survey.q4.opt${i}`)) ? 'bg-cyan-500/20 ring-1 ring-cyan-400/60' : 'bg-slate-800/60 hover:bg-slate-700/60'}`}>
              <input type="checkbox" checked={q4.includes(t(`survey.q4.opt${i}`))} onChange={() => toggleMulti(q4, setQ4, t(`survey.q4.opt${i}`))} className="accent-cyan-400" />
              <span className="text-slate-200">{t(`survey.q4.opt${i}`)}</span>
            </label>
          ))}
          <label className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer ${q4OtherOn ? 'bg-cyan-500/20 ring-1 ring-cyan-400/60' : 'bg-slate-800/60 hover:bg-slate-700/60'}`}>
            <input type="checkbox" checked={q4OtherOn} onChange={() => setQ4OtherOn(!q4OtherOn)} className="accent-cyan-400" />
            <span className="text-slate-200">{t('survey.q4.other')}</span>
          </label>
          {q4OtherOn && (
            <textarea value={q4Other} onChange={(e) => setQ4Other(e.target.value)} placeholder={t('survey.q4.otherPh')}
              className="w-full bg-slate-900/70 border border-slate-700 rounded-md px-2 py-1 text-sm text-slate-100" rows={2} maxLength={400} />
          )}
          <div className="flex justify-between gap-2 pt-1">
            <button onClick={() => setStep('q3')} className="px-3 py-2 game-button-secondary text-sm rounded-md">{t('survey.back')}</button>
            <button disabled={submitting} onClick={() => setStep('emailPass')} className="px-4 py-2 game-button text-white text-sm rounded-md disabled:opacity-40">{t('survey.next')}</button>
          </div>
        </div>
      )}

      {isEmailStep && (
        <div className="space-y-3">
          <p className="text-cyan-50 text-sm whitespace-pre-line">
            {step === 'emailWilling' ? t('survey.end.willing') : t('survey.end.pass')}
          </p>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('survey.emailPh')}
            className="w-full bg-slate-900/70 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100" />
          <p className="text-[10px] text-slate-500">{t('survey.privacy')}</p>
          {status && <p className={`text-xs ${status === 'success' || status === 'registered' ? 'text-cyan-300' : 'text-yellow-300'}`}>{t(`survey.status.${status}`)}</p>}
          <div className="flex justify-between gap-2 pt-1">
            <button onClick={() => setStep(q3 === 'nah' ? 'q4' : 'q3')} className="px-3 py-2 game-button-secondary text-sm rounded-md">{t('survey.back')}</button>
            <div className="flex gap-2">
              <button disabled={submitting} onClick={() => { void submit({ reachedEmail: 1, email: null }); }} className="px-3 py-2 game-button-secondary text-sm rounded-md">{t('survey.skip')}</button>
              <button disabled={submitting || !email.trim()} onClick={() => { void submit({ reachedEmail: 1, email: email.trim() }); }} className="px-4 py-2 game-button text-white text-sm rounded-md disabled:opacity-40">{submitting ? t('survey.submitting') : t('survey.cta')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
