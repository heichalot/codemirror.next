import {Text} from "../../doc/src/text"

declare global {
  interface Node { cmView: ViewDesc | undefined }
}

const NOT_DIRTY = 0, CHILD_DIRTY = 1, NODE_DIRTY = 2

export abstract class ViewDesc {
  constructor(public parent: ViewDesc | null, public dom: Node) {
    dom.cmView = this
  }

  abstract children: ViewDesc[];
  abstract length: number;
  dirty: number = NOT_DIRTY;

  get childGap() { return 0 }

  get posAtStart(): number {
    return this.parent ? this.parent.posBefore(this) : 0
  }

  get posAtEnd(): number {
    return this.posAtStart + this.length
  }

  posBefore(desc: ViewDesc): number {
    for (let i = 0, pos = this.posAtStart; i < this.children.length; i++) {
      let child = this.children[i]
      if (child == desc) return pos
      pos += child.length + this.childGap
    }
    throw new RangeError("Invalid child in posBefore")
  }

  posAfter(desc: ViewDesc): number {
    return this.posBefore(desc) + desc.length
  }

  syncDOMChildren() {
    let dom = this.dom.firstChild
    for (let i = 0; i < this.children.length; i++) {
      let desc = this.children[i], childDOM = desc.dom
      if (childDOM.parentNode == this.dom) {
        while (childDOM != dom) dom = rm(dom!)
        dom = dom.nextSibling
      } else {
        this.dom.insertBefore(childDOM, dom)
      }
    }
    while (dom) dom = rm(dom)
  }

  sync() {
    if (this.dirty & NODE_DIRTY)
      this.syncDOMChildren()
    if (this.dirty & CHILD_DIRTY)
      for (let i = 0; i < this.children.length; i++) this.children[i].sync()
    this.dirty = NOT_DIRTY
  }

  localPosFromDOM(node: Node, offset: number): number {
    let after: Node | null
    if (node == this.dom) {
      after = this.dom.childNodes[offset]
    } else {
      let bias = !node.firstChild ? 0 : offset == 0 ? -1 : 1
      for (;;) {
        let parent = node.parentNode!
        if (parent == this.dom) break
        if (bias == 0 && parent.firstChild != parent.lastChild) {
          if (node == parent.firstChild) bias = -1
          else bias = 1
        }
        node = parent
      }
      if (bias < 0) after = node
      else after = node.nextSibling
    }
    if (!after) return this.length

    for (let i = 0, pos = 0;; i++) {
      let child = this.children[i]
      if (child.dom == after) return pos
      pos += child.length + this.childGap
    }
  }

  domFromPos(pos: number): {node: Node, offset: number} {
    for (let offset = 0, i = 0; i < this.children.length; i++) {
      let child = this.children[i], end = offset + child.length
      if (pos <= end) return child.domFromPos(pos - offset)
      offset = end + this.childGap
    }
    return {node: this.dom, offset: this.dom.childNodes.length}
  }

  markDirty() {
    this.dirty |= NODE_DIRTY
    for (let parent = this.parent; parent; parent = parent.parent)
      parent.dirty |= CHILD_DIRTY
  }
}

// Remove a DOM node and return its next sibling.
function rm(dom: Node): Node {
  let next = dom.nextSibling
  dom.parentNode!.removeChild(dom)
  return next!
}

export class DocViewDesc extends ViewDesc {
  children: LineViewDesc[];

  get length() { return this.text.length }
  get childGap() { return 1 }

  constructor(public text: Text, dom: Element) {
    super(null, dom)
    this.children = [new LineViewDesc(this, [])]
    this.text = Text.create("")
    this.update(text)
    this.sync()
  }

  update(text: Text) {
    let prevText = this.text
    let plan = buildUpdatePlan(prevText, text)
    this.text = text

    let cur = new ChildCursor(this.children, prevText.length, 1)
    for (let i = 0; i < plan.length; i++) {
      let {prevStart, prevEnd, curStart, curEnd} = plan[i]
      let {i: toI, off: toOff} = cur.findPos(prevEnd)
      let {i: fromI, off: fromOff} = cur.findPos(prevStart)
      let lines = linesBetween(text, curStart, curEnd)

      if (lines.length == 1) {
        if (fromI == toI) { // Change within single line
          this.children[fromI].update(fromOff, toOff, lines[0])
          this.dirty |= CHILD_DIRTY
        } else { // Join lines
          let tail = this.children[toI].detachTail(toOff)
          this.children[fromI].update(fromOff, undefined, lines[0], tail)
          this.children.splice(fromI + 1, toI - fromI)
          this.dirty |= CHILD_DIRTY | NODE_DIRTY
        }
      } else { // Across lines
        let tail = this.children[toI].detachTail(toOff)
        this.children[fromI].update(fromOff, undefined, lines[0])
        let insert = []
        for (let j = 1; j < lines.length; j++)
          insert.push(new LineViewDesc(this, lines[j], j == lines.length - 1 ? tail : undefined))
        this.children.splice(fromI + 1, toI - fromI, ...insert)
        this.dirty |= CHILD_DIRTY | NODE_DIRTY
      }
    }
  }

  readDOMRange(from: number, to: number): {from: number, to: number, text: string} {
    // FIXME partially parse lines when possible
    let fromI = -1, fromStart = -1, toI = -1, toEnd = -1
    if (this.children.length == 0) return {from: 0, to: 0, text: readDOM(this.dom.firstChild, null)}
    for (let i = 0, pos = 0; i < this.children.length; i++) {
      let child = this.children[i], end = pos + child.length
      /*      if (pos < from && end > to) {
        let result = child.parseRange(from - pos, to - pos)
        return {from: result.from + pos, to: result.to + pos, text: result.text}
      }*/
      if (end >= from && fromI == -1) { fromI = i; fromStart = pos }
      if (end >= to && toI == -1) { toI = i; toEnd = end; break }
      pos = end + 1
    }
    let fromDesc = this.children[fromI], toDesc = this.children[toI]
    let startDOM = fromDesc.dom.parentNode == this.dom ? fromDesc.dom
      : (fromI ? this.children[fromI - 1].dom.nextSibling : null) || this.dom.firstChild
    let endDOM = toDesc.dom.parentNode == this.dom ? toDesc.dom.nextSibling
      : toI < this.children.length - 1 ? this.children[toI + 1].dom : null
    return {from: fromStart, to: toEnd, text: readDOM(startDOM, endDOM)}
  }

  nearest(dom: Node): ViewDesc | null {
    for (let cur: Node | null = dom; cur;) {
      let domView = cur.cmView
      if (domView) {
        for (let v: ViewDesc | null = domView; v; v = v.parent)
          if (v == this) return domView
      }
      cur = cur.parentNode
    }
    return null
  }

  posFromDOM(node: Node, offset: number): number {
    let desc = this.nearest(node)
    if (!desc) throw new RangeError("Trying to find position for a DOM position outside of the document")
    return desc.localPosFromDOM(node, offset) + desc.posAtStart
  }
}

const MAX_JOIN_LEN = 256

class LineViewDesc extends ViewDesc {
  children: TextViewDesc[];
  length: number;

  constructor(parent: DocViewDesc, content: string[], tail: TextViewDesc[] | null = null) {
    super(parent, document.createElement("div"))
    this.length = 0
    this.children = []
    this.update(0, 0, content, tail)
  }

  finishUpdate() {
/*    if (this.children.length == 0) {
      this.children.push(new EmptyLineHack(this))
      this.DIRTY |= CONTENT_DIRTY
    } else if (this.children.length > 1 && this.children[this.children.length - 1] instanceof EmptyLineHack) {
      this.children.pop()
      this.DIRTY |= CONTENT_DIRTY
    }*/
  }

  update(from: number, to: number = this.length, content: string[], tail: TextViewDesc[] | null = null) {
    let cur = new ChildCursor(this.children, this.length)
    let totalLen = 0
    for (let j = 0; j < content.length; j++) totalLen += content[j].length
    let dLen = totalLen - (to - from)

    let {i: toI, off: toOff} = cur.findPos(to)
    let {i: fromI, off: fromOff} = cur.findPos(from)

    if (fromI < this.children.length &&
        (toI == fromI || toI == fromI + 1 && toOff == 0) && content.length < 2 &&
        this.children[fromI].length + dLen <= MAX_JOIN_LEN) {
      this.children[fromI].update(fromOff, toI == fromI ? toOff : undefined, content.length ? content[0] : "")
      this.dirty |= CHILD_DIRTY
    } else {
      if (content.length > 0 && fromOff > 0 &&
          fromOff + content[0].length <= MAX_JOIN_LEN) {
        content[0] = this.children[fromI].text.slice(0, fromOff) + content[0]
        fromOff = 0
      } else if (content.length > 0 && fromOff == 0 && fromI > 0 &&
                 this.children[fromI - 1].length + content[0].length <= MAX_JOIN_LEN) {
        if (fromI == toI && toOff == 0) {
          this.children[fromI - 1].update(this.children[fromI - 1].length, undefined, content[0])
          this.dirty |= CHILD_DIRTY
          content.shift()
        } else {
          content[0] = this.children[fromI - 1].text + content[0]
          fromI--
        }
      } else if (fromOff > 0) {
        this.children[fromI].update(fromOff)
        this.dirty |= CHILD_DIRTY
        fromI++
      }
      if (content.length && toI < this.children.length &&
          this.children[toI].length - toOff + content[content.length - 1].length <= MAX_JOIN_LEN) {
        content[content.length - 1] += this.children[toI].text.slice(toOff)
        toI++
      } else if (toOff > 0) {
        this.children[toI].update(0, toOff)
        this.dirty |= CHILD_DIRTY
      }

      if (toI > fromI || content.length) {
        this.children.splice(fromI, toI - fromI, ...content.map(t => new TextViewDesc(this, t)))
        this.dirty |= NODE_DIRTY | CHILD_DIRTY
      }
    }
    this.length += dLen

    if (tail) {
      this.dirty |= NODE_DIRTY | CHILD_DIRTY
      for (let i = 0; i < tail.length; i++) {
        let child = tail[i]
        child.parent = this
        this.children.push(child)
        this.length += child.length
      }
    }
    this.finishUpdate()
  }

  detachTail(from: number): TextViewDesc[] {
    let {i, off} = new ChildCursor(this.children, this.length).findPos(from)
    let result = []
    if (off > 0) {
      result.push(new TextViewDesc(this, this.children[i].text.slice(off)))
      this.children[i].update(off)
      this.dirty |= CHILD_DIRTY
      i++
    }
    if (i < this.children.length) {
      for (; i < this.children.length; i++) result.push(this.children[i])
      this.children.length = i
      this.dirty |= NODE_DIRTY
    }
    this.length = from
    return result
  }
}

const noChildren: ViewDesc[] = []

class TextViewDesc extends ViewDesc {
  constructor(parent: LineViewDesc, public text: string) {
    super(parent, document.createTextNode(text))
  }

  get children() { return noChildren }
  get length() { return this.text.length }


  update(from: number, to: number = this.text.length, content: string = "") {
    this.text = this.text.slice(0, from) + content + this.text.slice(to)
    this.dirty |= NODE_DIRTY
  }

  sync() {
    if ((this.dirty & NODE_DIRTY) && this.dom.nodeValue != this.text)
      this.dom.nodeValue = this.text
    this.dirty = NOT_DIRTY
  }

  localPosFromDOM(_node: Node, offset: number): number {
    return offset
  }

  domFromPos(pos: number): {node: Node, offset: number} {
    return {node: this.dom, offset: pos}
  }
}

interface UpdateRange {
  prevStart: number, curStart: number, prevEnd: number, curEnd: number
}

// FIXME more intelligent diffing
function buildUpdatePlan(prev: Text, current: Text): UpdateRange[] {
  let plan: UpdateRange[] = []

  function scanChildren(startOff: number, prev: Text, current: Text) {
    let chPrev = prev.children, chCur= current.children
    if (chPrev == null || chCur == null) {
      scanText(startOff, prev.text, current.text) // FIXME may concatenate a huge string (scanText should iterate nodes)
      return
    }
    let minLen = Math.min(chPrev.length, chCur.length)
    let start = 0, skipOff = startOff, end  = 0
    while (start < minLen && chPrev[start] != chCur[start]) { start++; skipOff += chPrev[start].length + 1 }
    while (end < minLen - start &&
           chPrev[chPrev.length - 1 - end] == chCur[chCur.length - 1 - end]) end++
    if (chPrev.length == chCur.length && start + end + 1 >= minLen) {
      if (start + end != minLen)
        scanChildren(skipOff, chPrev[start], chCur[start])
    } else {
      let prevText = "", curText = ""
      for (let i = start; i < chPrev.length - end; i++) prevText += chPrev[i].text
      for (let i = start; i < chCur.length - end; i++) curText += chCur[i].text
      scanText(skipOff, prevText, curText)
    }
  }

  function scanText(startOff: number, prev: string, current: string) {
    let start = 0, end = 0, minLen = Math.min(prev.length, current.length)
    while (start < minLen && prev.charCodeAt(start) == current.charCodeAt(start)) start++
    if (start == minLen && prev.length == current.length) return
    while (end < minLen- start &&
           prev.charCodeAt(prev.length - 1 - end) == current.charCodeAt(current.length - 1 - end)) end++
    plan.push({prevStart: startOff + start, curStart: startOff + start,
               prevEnd: startOff + prev.length - end, curEnd: startOff + current.length - end})
  }

  scanChildren(0, prev, current)
  return plan
}

function readDOM(start: Node | null, end: Node | null): string {
  let text = "", cur = start
  if (cur) for (;;) {
    text += readDOMNode(cur!)
    let next: Node | null = cur!.nextSibling
    if (next == end) break
    if (isBlockNode(cur!)) text += "\n"
    cur = next
  }
  return text
}

function readDOMNode(node: Node): string {
  // FIXME add a way to ignore certain nodes based on their desc
  if (node.nodeType == 3) return node.nodeValue as string
  if (node.nodeName == "BR") return "\n"
  if (node.nodeType == 1) return readDOM(node.firstChild, null)
  return ""
}

function isBlockNode(node: Node): boolean {
  return node.nodeType == 1 && /^(DIV|P|LI|UL|OL|BLOCKQUOTE|DD|DT|H\d|SECTION|PRE)$/.test(node.nodeName)
}

class ChildCursor {
  i: number;
  off: number = 0;

  constructor(public children: ViewDesc[], public pos: number, public gap: number = 0) {
    this.i = children.length
    this.pos += gap
  }

  findPos(pos: number): this {
    for (;;) {
      if (pos >= this.pos) {
        this.off = pos - this.pos
        return this
      }
      this.pos -= this.children[--this.i].length + this.gap
    }
  }
}

function linesBetween(text: Text, start: number, end: number): string[][] {
  let result: string[][] = [[]]
  if (start == end) return result
  for (let textCur = text.iterRange(start, end);;) {
    let {value, done} = textCur.next()
    if (done) return result
    for (let pos = 0;;) {
      let nextNewline = value.indexOf("\n", pos)
      if (nextNewline == -1) {
        if (pos < value.length) result[result.length - 1].push(value.slice(pos))
        break
      } else {
        if (nextNewline > pos) result[result.length - 1].push(value.slice(pos, nextNewline))
        result.push([])
        pos = nextNewline + 1
      }
    }
  }
}