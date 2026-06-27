/* SVG board renderer + click handling. Framework-free.
 * Renders any size, stones, last-move marker, star points, and an optional
 * "ghost" stone on hover. Calls back onPlay(point) for empty-point clicks.
 */
(function (GT) {
  "use strict";
  var E = GT.engine;

  function BoardView(host, opts) {
    this.host = host;
    this.size = opts.size || 19;
    this.onPlay = opts.onPlay || function () {};
    this.interactive = opts.interactive !== false;
    this.showCoords = opts.showCoords !== false;
    this.hoverColor = opts.hoverColor || E.BLACK;
    this.pad = 26;        // padding for coordinate labels
    this.svg = null;
    this.cell = 0;
    this._build();
  }

  BoardView.prototype.setSize = function (size) {
    this.size = size; this._build();
  };
  BoardView.prototype.setHoverColor = function (c) { this.hoverColor = c; };
  BoardView.prototype.setInteractive = function (b) { this.interactive = b; };

  BoardView.prototype._build = function () {
    var n = this.size, host = this.host;
    host.innerHTML = "";
    var dim = host.clientWidth || 560;
    dim = Math.max(280, Math.min(dim, 640));
    var pad = this.pad;
    var inner = dim - pad * 2;
    var cell = inner / (n - 1);
    this.cell = cell;
    this.dim = dim;

    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + dim + " " + dim);
    svg.setAttribute("class", "goban");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");

    // wood background
    var bg = el(svgNS, "rect", { x: 0, y: 0, width: dim, height: dim, rx: 6, class: "goban-bg" });
    svg.appendChild(bg);

    // grid lines
    for (var i = 0; i < n; i++) {
      var pos = pad + i * cell;
      svg.appendChild(el(svgNS, "line", { x1: pad, y1: pos, x2: dim - pad, y2: pos, class: "grid" }));
      svg.appendChild(el(svgNS, "line", { x1: pos, y1: pad, x2: pos, y2: dim - pad, class: "grid" }));
    }

    // star points (hoshi)
    var stars = starPoints(n);
    for (var s = 0; s < stars.length; s++) {
      var rc = stars[s];
      svg.appendChild(el(svgNS, "circle", {
        cx: pad + rc[1] * cell, cy: pad + rc[0] * cell, r: Math.max(2, cell * 0.08), class: "hoshi"
      }));
    }

    // coordinate labels
    if (this.showCoords) {
      var letters = "ABCDEFGHJKLMNOPQRST";
      for (var c = 0; c < n; c++) {
        svg.appendChild(text(svgNS, pad + c * cell, pad - 10, letters[c], "coord"));
        svg.appendChild(text(svgNS, pad + c * cell, dim - pad + 16, letters[c], "coord"));
      }
      for (var r = 0; r < n; r++) {
        var lbl = String(n - r);
        svg.appendChild(text(svgNS, pad - 14, pad + r * cell + 4, lbl, "coord"));
        svg.appendChild(text(svgNS, dim - pad + 14, pad + r * cell + 4, lbl, "coord"));
      }
    }

    // layers for stones + markers + hover
    this.stoneLayer = el(svgNS, "g", {});
    this.markLayer = el(svgNS, "g", {});
    this.hoverLayer = el(svgNS, "g", {});
    svg.appendChild(this.stoneLayer);
    svg.appendChild(this.markLayer);
    svg.appendChild(this.hoverLayer);

    // invisible click/hover overlay
    var overlay = el(svgNS, "rect", { x: 0, y: 0, width: dim, height: dim, class: "overlay", fill: "transparent" });
    svg.appendChild(overlay);

    var self = this;
    overlay.addEventListener("mousemove", function (ev) { self._hover(ev); });
    overlay.addEventListener("mouseleave", function () { self.hoverLayer.innerHTML = ""; });
    overlay.addEventListener("click", function (ev) {
      if (!self.interactive) return;
      var p = self._pointFromEvent(ev);
      if (p != null) self.onPlay(p);
    });

    host.appendChild(svg);
    this.svg = svg;
    this.svgNS = svgNS;
  };

  BoardView.prototype._pointFromEvent = function (ev) {
    var rect = this.svg.getBoundingClientRect();
    var scale = this.dim / rect.width;
    var x = (ev.clientX - rect.left) * scale;
    var y = (ev.clientY - rect.top) * scale;
    var c = Math.round((x - this.pad) / this.cell);
    var r = Math.round((y - this.pad) / this.cell);
    if (r < 0 || c < 0 || r >= this.size || c >= this.size) return null;
    return r * this.size + c;
  };

  BoardView.prototype._hover = function (ev) {
    if (!this.interactive) return;
    this.hoverLayer.innerHTML = "";
    var p = this._pointFromEvent(ev);
    if (p == null || !this._lastBoard || this._lastBoard[p] !== E.EMPTY) return;
    var r = Math.floor(p / this.size), c = p % this.size;
    var ghost = el(this.svgNS, "circle", {
      cx: this.pad + c * this.cell, cy: this.pad + r * this.cell,
      r: this.cell * 0.46, class: "stone ghost " + (this.hoverColor === E.BLACK ? "black" : "white")
    });
    this.hoverLayer.appendChild(ghost);
  };

  /* Render a board state. board = Int8Array; lastMove optional point;
   * marks optional array of {p, kind:'dot'|'sq'|'tri', cls}. */
  BoardView.prototype.render = function (board, lastMove, marks, overlay) {
    this._lastBoard = board;
    this.stoneLayer.innerHTML = "";
    this.markLayer.innerHTML = "";
    var n = this.size, pad = this.pad, cell = this.cell, ns = this.svgNS;
    var dead = (overlay && overlay.dead) || null;
    var territory = (overlay && overlay.territory) || null;
    var numbers = (overlay && overlay.numbers) || null;
    var flash = (overlay && overlay.flash) || null;
    for (var p = 0; p < board.length; p++) {
      var v = board[p];
      if (v === E.EMPTY) continue;
      var r = Math.floor(p / n), c = p % n;
      var isDead = dead && (dead instanceof Set ? dead.has(p) : dead[p]);
      this.stoneLayer.appendChild(el(ns, "circle", {
        cx: pad + c * cell, cy: pad + r * cell, r: cell * 0.46,
        class: "stone " + (v === E.BLACK ? "black" : "white") + (isDead ? " dead" : "")
      }));
      if (isDead) {
        // small cross marking the stone as dead
        var x = pad + c * cell, y = pad + r * cell, d = cell * 0.18;
        this.markLayer.appendChild(el(ns, "line", { x1: x - d, y1: y - d, x2: x + d, y2: y + d, class: "dead-x" }));
        this.markLayer.appendChild(el(ns, "line", { x1: x - d, y1: y + d, x2: x + d, y2: y - d, class: "dead-x" }));
      }
    }
    if (territory) {
      for (var tp in territory) {
        var t = +tp, tr = Math.floor(t / n), tc = t % n;
        this.markLayer.appendChild(el(ns, "rect", {
          x: pad + tc * cell - cell * 0.12, y: pad + tr * cell - cell * 0.12,
          width: cell * 0.24, height: cell * 0.24,
          class: "terr " + (territory[tp] === E.BLACK ? "terr-black" : "terr-white")
        }));
      }
    }
    if (numbers) {
      for (var np in numbers) {
        var pi = +np, nr = Math.floor(pi / n), nc = pi % n;
        if (board[pi] === E.EMPTY) continue;
        var tx = text(ns, pad + nc * cell, pad + nr * cell + cell * 0.14, String(numbers[np]),
          "movenum " + (board[pi] === E.BLACK ? "on-black" : "on-white"));
        tx.setAttribute("font-size", Math.max(7, cell * 0.34));
        this.markLayer.appendChild(tx);
      }
    }
    if (flash) {
      for (var f = 0; f < flash.length; f++) {
        var fr = Math.floor(flash[f] / n), fc = flash[f] % n;
        var c2 = el(ns, "circle", { cx: pad + fc * cell, cy: pad + fr * cell, r: cell * 0.46, class: "capflash" });
        this.markLayer.appendChild(c2);
      }
    }
    if (lastMove != null && lastMove >= 0 && board[lastMove] !== E.EMPTY) {
      var lr = Math.floor(lastMove / n), lc = lastMove % n;
      this.markLayer.appendChild(el(ns, "circle", {
        cx: pad + lc * cell, cy: pad + lr * cell, r: cell * 0.16,
        class: "last-mark " + (board[lastMove] === E.BLACK ? "on-black" : "on-white")
      }));
    }
    if (marks) {
      for (var m = 0; m < marks.length; m++) {
        var mk = marks[m], mr = Math.floor(mk.p / n), mc = mk.p % n;
        this.markLayer.appendChild(el(ns, "circle", {
          cx: pad + mc * cell, cy: pad + mr * cell, r: cell * 0.22,
          class: "hint-mark " + (mk.cls || "")
        }));
      }
    }
  };

  function starPoints(n) {
    var pts = [];
    var edge = n >= 13 ? 3 : 2;
    var mid = (n - 1) / 2;
    var coords;
    if (n >= 13) {
      coords = [edge, mid, n - 1 - edge];
    } else if (n === 9) {
      coords = [2, 4, 6];
    } else {
      coords = [edge, n - 1 - edge];
    }
    for (var i = 0; i < coords.length; i++)
      for (var j = 0; j < coords.length; j++) {
        // only integer centers
        if (Number.isInteger(coords[i]) && Number.isInteger(coords[j]))
          pts.push([coords[i], coords[j]]);
      }
    // for even mids skip non-integers (handled by isInteger above)
    return pts;
  }

  function el(ns, name, attrs) {
    var e = document.createElementNS(ns, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function text(ns, x, y, str, cls) {
    var t = el(ns, "text", { x: x, y: y, class: cls, "text-anchor": "middle" });
    t.textContent = str;
    return t;
  }

  GT.BoardView = BoardView;
})(window.GT = window.GT || {});
