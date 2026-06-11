APP_STYLESHEET = """
QWidget {
  font-family: "Microsoft JhengHei UI", "Segoe UI", sans-serif;
  font-size: 13px;
  color: #1a1a1a;
  background: #f4f6f8;
}
QTabWidget::pane {
  border: 1px solid #d8dee6;
  background: #ffffff;
  border-radius: 8px;
}
QTabBar::tab {
  padding: 8px 16px;
  margin-right: 4px;
  background: #e8edf2;
  border-top-left-radius: 6px;
  border-top-right-radius: 6px;
}
QTabBar::tab:selected {
  background: #ffffff;
  font-weight: 600;
}
QPushButton {
  padding: 6px 12px;
  border: 1px solid #c5ced8;
  border-radius: 6px;
  background: #ffffff;
}
QPushButton:hover { background: #eef3f8; }
QPushButton:disabled { color: #9aa5b1; }
QPushButton#primary {
  background: #2563eb;
  color: white;
  border-color: #2563eb;
}
QPushButton#copyNameBtn {
  margin: 4px 0 4px 8px;
  padding: 2px 10px;
  font-size: 13px;
  border: 1px solid #c5ced8;
  border-radius: 6px;
  background: #ffffff;
}
QPushButton#copyNameBtn:hover {
  background: #eef3f8;
  border-color: #94a3b8;
}
QFrame#card {
  background: #ffffff;
  border: 1px solid #d8dee6;
  border-radius: 8px;
}
QLabel#muted { color: #64748b; }
QLineEdit, QTextEdit, QListWidget, QTableWidget {
  border: 1px solid #d8dee6;
  border-radius: 6px;
  background: #ffffff;
}
QTableWidget {
  gridline-color: #e8edf2;
  selection-background-color: #dbeafe;
  selection-color: #1a1a1a;
  outline: none;
}
QTableWidget::item {
  padding: 4px 8px;
  border-bottom: 1px solid #e8edf2;
}
QHeaderView::section {
  background: #f1f5f9;
  color: #475569;
  padding: 8px 10px;
  border: none;
  border-bottom: 1px solid #d8dee6;
  font-weight: 600;
}
QProgressBar {
  border: none;
  background: #e8edf2;
  border-radius: 4px;
  height: 8px;
  text-align: center;
}
QProgressBar::chunk {
  background: #2563eb;
  border-radius: 4px;
}
QProgressBar#merge::chunk { background: #16a34a; }
"""
