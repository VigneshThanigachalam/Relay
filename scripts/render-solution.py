"""Rebuild the one-page interview handout: python3 scripts/render-solution.py.

Optional documentation tooling: pip install reportlab, plus DejaVu Sans fonts.
The generated PDF embeds fonts; no PDF tooling is required to run the application.
"""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

pdfmetrics.registerFont(TTFont("Desk", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("Desk-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))
pdfmetrics.registerFontFamily("Desk", normal="Desk", bold="Desk-Bold", italic="Desk", boldItalic="Desk-Bold")
from reportlab.lib.colors import HexColor, white
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / 'docs' / 'solution-one-page.pdf'
TEAL = HexColor('#153e35')
INK = HexColor('#243d32')
MUTED = HexColor('#607366')
GOLD = HexColor('#b28c39')
WIDTH, HEIGHT = 612, 792
c = canvas.Canvas(str(TARGET), pagesize=(WIDTH, HEIGHT), pageCompression=1)
c.setTitle('Project RELAY - The Autonomous Dispatch Desk')
c.setAuthor('Codex Implementation Agent')


def text(x, y, value, size=10, color=INK, bold=False):
    c.setFillColor(color)
    c.setFont('Desk-Bold' if bold else 'Desk', size)
    c.drawString(x, y, value)


def paragraph(x, top, value, width, size=10, color=INK, leading=None):
    style = ParagraphStyle('body', fontName='Desk', fontSize=size,
                           leading=leading or size * 1.45, textColor=color)
    p = Paragraph(value, style)
    _, height = p.wrap(width, HEIGHT)
    p.drawOn(c, x, top - height)
    return top - height


def card(x, y, width, height, fill='#ffffff'):
    c.setFillColor(HexColor(fill))
    c.setStrokeColor(HexColor('#dce3d9'))
    c.roundRect(x, y, width, height, 7, fill=1, stroke=1)


c.setFillColor(HexColor('#f4f5f0'))
c.rect(0, 0, WIDTH, HEIGHT, fill=1, stroke=0)
c.setFillColor(TEAL)
c.rect(0, 672, WIDTH, 120, fill=1, stroke=0)
text(36, 756, 'PROJECT RELAY', 10, HexColor('#d4bf83'), True)
text(36, 720, 'The Autonomous Dispatch Desk', 26, white, True)
text(36, 695, 'Clear decisions. Safe reservations. Recoverable exceptions.', 11, HexColor('#d9e8dc'))

text(36, 646, 'THE PROBLEM / THE SOLUTION', 9, MUTED, True)
paragraph(36, 632, 'Manual availability checks and unanswered assignments leave deliveries idle. RELAY gives operators one desk to rank riders, progress work and recover stuck jobs, with a reliable explanation of every decision.', 540, 11)

card(36, 502, 540, 65, '#eaf2e8')
text(52, 548, 'DISPATCHER WORKFLOW', 9, TEAL, True)
paragraph(52, 535, '<b>Create > ready > scores / override > assign > confirm > pickup > deliver</b><br/>Reject or timeout > investigate manual queue > reassign as a new attempt.', 506, 10, TEAL)

card(36, 328, 263, 157)
text(52, 463, 'EXPLAINABLE RECOMMENDATIONS', 9, TEAL, True)
paragraph(52, 446, '<b>Hard gates:</b> available, covers both zones and has enough free capacity.<br/><br/><b>Lowest cost:</b> priority-weighted zone travel + workload + deadline lateness.<br/><br/>Stable ties and stored breakdowns explain ranks. Another eligible choice requires a reason; hard gates always apply.', 230, 9, leading=12)

card(313, 328, 263, 157, '#fff9e9')
text(329, 463, 'AUTOMATIC EXCEPTION HANDLING', 9, TEAL, True)
paragraph(329, 446, '<b>Persist expiresAt:</b> default two hours, configurable for a short demo. Startup scans recover overdue work after downtime.<br/><br/>Rejection or expiry atomically enters manual, ends the attempt, releases capacity once and appends history.<br/><br/>Investigate retained attempts, then reassign.', 230, 9, leading=12)

text(36, 306, 'ONE MODULAR MONOLITH / FOUR WORKFLOW COLLECTIONS', 9, MUTED, True)
for x, title, subtitle in [(36, 'React + TypeScript', 'Vite dispatch desk'), (222, 'Express + TypeScript', 'Zod / services / worker'), (408, 'MongoDB replica set', 'Mongoose transactions')]:
    card(x, 247, 168, 43)
    text(x + 10, 273, title, 9, TEAL, True)
    text(x + 10, 259, subtitle, 8, MUTED)
text(209, 264, '>', 10, MUTED)
text(395, 264, '>', 10, MUTED)
paragraph(36, 236, '<b>Jobs</b> track delivery state. <b>Riders</b> track availability and reserved workload.<br/><b>Assignments</b> retain each attempt, receipt and score. <b>Events</b> explain the ordered history.', 540, 9.5, leading=14)

card(36, 116, 540, 77)
text(52, 172, 'THE IMPORTANT TRADE-OFF', 9, TEAL, True)
paragraph(52, 159, 'Fast counters require replica-set transactions: state, capacity, attempt and audit commit together. Guarded writes and unique indexes prevent conflicts. Polling avoids extra infrastructure but adds processing latency.', 506, 9.5, leading=13)

text(36, 103, 'WITH ANOTHER WEEK', 9, MUTED, True)
paragraph(36, 90, '<b>1.</b> Authenticate roles and strengthen actor/audit access.<br/><b>2.</b> Monitor worker lag and counter drift; add reconciliation and deployment safeguards.<br/><b>3.</b> Improve travel estimates and post-pickup exceptions using observed outcomes.', 540, 9.5, leading=14)
text(36, 24, 'Local workflow verified with real MongoDB, automated races and Chromium. Demo actors; simulated travel.', 8, MUTED)
c.showPage()
c.save()
print(TARGET)
