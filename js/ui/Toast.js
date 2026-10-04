export class Toast {
  constructor(el) { this.el = el; this.timer = 0; }
  show(text, ms = 2200) { this.el.textContent = text; this.el.hidden = false; clearTimeout(this.timer); this.timer = setTimeout(() => { this.el.hidden = true; }, ms); }
}
