
import React from 'react';

interface DialogBoxProps {
  lines: string[];
  onNext: () => void;
  isEnding?: boolean;
  image?: string; // Optional image URL for the speaker
}

export const DialogBox: React.FC<DialogBoxProps> = ({ lines, onNext, isEnding, image }) => {
  return (
    <div className="absolute bottom-5 left-1/2 -translate-x-1/2 w-[min(94vw,960px)] game-panel-strong rounded-lg p-4 z-40">
      <div className="relative flex flex-row gap-4 items-start">
        {image && (
          <div className="shrink-0 rounded-md border border-cyan-300/30 bg-slate-950/50 p-1">
            <img 
              src={image} 
              alt="Speaker" 
              className="w-20 h-28 md:w-24 md:h-32 object-cover rounded-sm" 
              style={{ imageRendering: 'pixelated' }}
            />
          </div>
        )}

        <div className="flex-1 flex flex-col gap-2 min-h-[112px] md:min-h-[136px] justify-between">
          <div className="space-y-2">
            {lines.map((line, idx) => (
              <p key={idx} className={`font-mono text-base md:text-xl leading-snug ${idx === lines.length - 1 ? 'text-white' : 'text-slate-400'}`}>
                <span className="text-cyan-300 mr-2">{'>'}</span>
                {line}
              </p>
            ))}
          </div>
          
          <button 
            onClick={onNext}
            className="self-end game-button-secondary text-cyan-100 px-3 py-1.5 rounded-md text-sm md:text-base font-bold"
          >
            {isEnding ? "▼ 结束通讯" : "▼ 继续"}
          </button>
        </div>
      </div>
    </div>
  );
};
