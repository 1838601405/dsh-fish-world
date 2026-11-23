(function () {
  // Flutter 首帧绘出后移除骨架；它不再派发 flutter-first-frame，所以用兜底：
  // 监听 flt-glass-pane 出现（首帧挂载）+ 固定上限，两条件任一满足就收起。
  var el = document.getElementById('splash');
  if (!el) return;
  var done = false;
  function drop() {
    if (done) return;
    done = true;
    el.classList.add('gone');
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 220);
  }
  var timer = setInterval(function () {
    if (document.querySelector('flutter-view, flt-glass-pane, flt-scene-host')) {
      clearInterval(timer);
      drop();
    }
  }, 80);
  setTimeout(drop, 8000);
})();
