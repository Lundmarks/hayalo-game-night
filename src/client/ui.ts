import type { Player } from '../shared/protocol.ts';

export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function avatar(p: Player | undefined, size = 32) {
  if (!p) return `<span class="avatar empty" style="--s:${size}px"></span>`;
  if (p.avatarUrl) return `<img class="avatar" style="--s:${size}px" src="${esc(p.avatarUrl)}" alt="" />`;
  return `<span class="avatar initial" style="--s:${size}px">${esc(p.name.slice(0, 1).toUpperCase())}</span>`;
}

let toastTimer = 0;
export function toast(message: string) {
  let el = document.querySelector<HTMLElement>('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), 2500);
}

// A game screen. Created when the game opens, updated on every state change,
// destroyed when the room goes back to the launcher.
export interface GameView {
  update(room: import('../shared/protocol.ts').RoomView, me: Player): void;
  event?(event: unknown): void;
  destroy?(): void;
}

export type ViewFactory = (el: HTMLElement, send: (action: unknown) => void) => GameView;
