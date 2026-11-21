#include "flutter_window.h"

#include <optional>

#include "flutter/generated_plugin_registrant.h"
#include <commctrl.h>
#pragma comment(lib, "comctl32.lib")

namespace {
LRESULT CALLBACK ChildHitTest(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam,
                              UINT_PTR, DWORD_PTR ref) {
  if (msg == WM_NCHITTEST) {
    HWND parent = reinterpret_cast<HWND>(ref);
    LRESULT hit = SendMessage(parent, WM_NCHITTEST, wparam, lparam);
    if (hit != HTCLIENT) return hit;
  }
  return DefSubclassProc(hwnd, msg, wparam, lparam);
}
}  // namespace

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  HWND child = flutter_controller_->view()->GetNativeWindow();
  SetChildContent(child);
  // Flutter 的子窗口会吃掉边缘命中测试；把 NCHITTEST 转发给顶层，拖边缩放才生效。
  SetWindowSubclass(child, ChildHitTest, 1,
                    reinterpret_cast<DWORD_PTR>(GetHandle()));

  window_channel_ = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "fish/window",
      &flutter::StandardMethodCodec::GetInstance());
  window_channel_->SetMethodCallHandler(
      [this](const flutter::MethodCall<flutter::EncodableValue>& call,
             std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
        HWND hwnd = GetHandle();
        if (!hwnd) { result->Error("no-window"); return; }
        const std::string& method = call.method_name();
        if (method == "minimize") {
          ShowWindow(hwnd, SW_MINIMIZE);
        } else if (method == "toggleMaximize") {
          ShowWindow(hwnd, IsZoomed(hwnd) ? SW_RESTORE : SW_MAXIMIZE);
        } else if (method == "close") {
          PostMessage(hwnd, WM_CLOSE, 0, 0);
        } else if (method == "startDrag") {
          ReleaseCapture();
          PostMessage(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
        } else if (method == "startResize") {
          int edge = HTBOTTOMRIGHT;
          if (auto* arg = std::get_if<std::string>(call.arguments())) {
            if (*arg == "left") edge = HTLEFT;
            else if (*arg == "right") edge = HTRIGHT;
            else if (*arg == "top") edge = HTTOP;
            else if (*arg == "bottom") edge = HTBOTTOM;
            else if (*arg == "topLeft") edge = HTTOPLEFT;
            else if (*arg == "topRight") edge = HTTOPRIGHT;
            else if (*arg == "bottomLeft") edge = HTBOTTOMLEFT;
          }
          ReleaseCapture();
          SendMessage(hwnd, WM_NCLBUTTONDOWN, (WPARAM)edge, 0);
        } else {
          result->NotImplemented();
          return;
        }
        result->Success();
      });

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  // 缩放/最大化边界必须先于 Flutter 处理：Flutter 子窗口会吃掉命中测试，
  // 导致无边框窗口拖边拉不动。
  if (message == WM_NCHITTEST || message == WM_NCCALCSIZE ||
      message == WM_GETMINMAXINFO) {
    return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
  }

  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
