APP_STYLESHEET = """
QWidget {
  font-family: "Microsoft JhengHei UI", "Segoe UI", sans-serif;
  font-size: 13px;
  color: #e2e8f0;
  background: #1a1d23;
}
QMainWindow, QDialog {
  background: #1a1d23;
  color: #e2e8f0;
}
QTabWidget::pane {
  border: 1px solid #334155;
  background: #23272f;
  border-radius: 8px;
}
QTabBar::tab {
  padding: 8px 16px;
  margin-right: 4px;
  background: #2d333b;
  color: #94a3b8;
  border-top-left-radius: 6px;
  border-top-right-radius: 6px;
}
QTabBar::tab:selected {
  background: #23272f;
  color: #f1f5f9;
  font-weight: 600;
}
QPushButton {
  padding: 6px 12px;
  border: 1px solid #475569;
  border-radius: 6px;
  background: #2d333b;
  color: #e2e8f0;
}
QPushButton:hover { background: #374151; border-color: #64748b; }
QPushButton:disabled { color: #64748b; background: #252930; }
QPushButton#primary {
  background: #2563eb;
  color: white;
  border-color: #2563eb;
}
QPushButton#primary:hover { background: #1d4ed8; }
QPushButton#copyNameBtn {
  margin: 4px 0 4px 8px;
  padding: 2px 10px;
  font-size: 13px;
  border: 1px solid #475569;
  border-radius: 6px;
  background: #2d333b;
  color: #e2e8f0;
}
QPushButton#copyNameBtn:hover {
  background: #374151;
  border-color: #64748b;
}
QPushButton#danger {
  color: #fca5a5;
  border-color: #7f1d1d;
}
QFrame#card {
  background: #23272f;
  border: 1px solid #334155;
  border-radius: 8px;
}
QLabel#muted { color: #94a3b8; }
QLineEdit, QTextEdit, QPlainTextEdit, QListWidget, QTableWidget, QSpinBox {
  border: 1px solid #475569;
  border-radius: 6px;
  background: #1e2229;
  color: #e2e8f0;
  selection-background-color: #2563eb;
  selection-color: #ffffff;
}
QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus {
  border-color: #2563eb;
}
QTableWidget {
  gridline-color: #334155;
  alternate-background-color: #262b33;
  outline: none;
}
QTableWidget::item {
  padding: 4px 8px;
  border-bottom: 1px solid #334155;
}
QHeaderView::section {
  background: #2d333b;
  color: #94a3b8;
  padding: 8px 10px;
  border: none;
  border-bottom: 1px solid #475569;
  font-weight: 600;
}
QScrollArea {
  border: none;
  background: transparent;
}
QScrollBar:vertical {
  background: #1e2229;
  width: 10px;
  border-radius: 5px;
}
QScrollBar::handle:vertical {
  background: #475569;
  border-radius: 5px;
  min-height: 24px;
}
QScrollBar::handle:vertical:hover { background: #64748b; }
QScrollBar:horizontal {
  background: #1e2229;
  height: 10px;
  border-radius: 5px;
}
QScrollBar::handle:horizontal {
  background: #475569;
  border-radius: 5px;
  min-width: 24px;
}
QListWidget::item:selected {
  background: #2563eb;
  color: #ffffff;
}
QProgressBar {
  border: none;
  background: #334155;
  border-radius: 4px;
  height: 8px;
  text-align: center;
  color: #e2e8f0;
}
QProgressBar::chunk {
  background: #2563eb;
  border-radius: 4px;
}
QProgressBar#merge::chunk { background: #16a34a; }
QToolTip {
  background: #2d333b;
  color: #e2e8f0;
  border: 1px solid #475569;
}
"""
