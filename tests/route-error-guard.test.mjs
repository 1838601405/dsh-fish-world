// 路由兜底：handler 里没接住的异常必须变成「带原因的错误体」。
//
// 真实故障（主人 2026-10-27 截图）：日记卡显示「读取失败：HTTP 400」，
// 「主人与鱼」永远停在「读取中…」。原因是世界没绑定工作区时
// world.* 一律 requireReady() 抛错，而 /world/diary 没有 try/catch ——
// 异常冒到宿主被包成一句干巴巴的 400，真话（「鱼的世界尚未绑定到工作区」）丢了。
import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildRoutes } from '../lib/http.mjs'

function response() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true },
    end(value) { this.body = String(value || '') },
    json() { return JSON.parse(this.body) },
  }
}

const request = ({ method = 'GET', url = '/', body = null } = {}) => ({
  method,
  url,
  socket: { remoteAddress: '127.0.0.1' },
  async *[Symbol.asyncIterator]() { if (body != null) yield Buffer.from(JSON.stringify(body)) },
})

/** 只接一个会抛错的 world：其余依赖给最小形状。 */
function routesWith(worldOver = {}) {
  const roles = { current: () => ({ id: 'default', name: '鱼' }), list: () => [], summary: () => ({ current: null, roles: [], count: 0 }) }
  const throwing = () => { throw new Error('鱼的世界尚未绑定到工作区') }
  const world = {
    status: () => ({ ok: false, ready: false }),
    listDiary: throwing,
    listDiaryComments: throwing,
    interactionTimeline: throwing,
    ...worldOver,
  }
  return buildRoutes({ loader: { list: () => [] }, market: {}, qq: {}, roles, world, configStore: {} })
}

const routeFor = (routes, path) => {
  const hit = routes.find((r) => r.path === path)
  assert.ok(hit, `找不到路由 ${path}`)
  return hit
}

test('世界未绑定：日记路由要回原因，不许冒成裸 4xx', async () => {
  const routes = routesWith()
  const res = response()
  await routeFor(routes, '/dsh-fish-world/world/diary').handler(request(), res)
  // ★ 2026-11-20 更新预期：当年是「异常 → 500 + 真话」，
  //   后来又前进一步改成 unboundWorld() → 200 + ok:false + ready:false。
  //   理由：面板要能显示「未绑定」并继续渲染，500 会让整页进错误态。
  //   判据意图不变 —— **真话必须到面板上**，不许只剩一个状态码。
  assert.equal(res.statusCode, 200, '未绑定是可预期的状态，不是服务端故障')
  const body = res.json()
  assert.equal(body.ok, false, '要明确说没成')
  assert.equal(body.ready, false, '要明确说世界没就绪')
  assert.equal(body.error, '鱼的世界尚未绑定到工作区', '必须把真话带到面板上')
  assert.deepEqual(body.entries, [], '读路由仍要给空数组，面板才不会在 undefined 上崩')
  assert.deepEqual(body.comments, [])
})

test('兜底覆盖全部路由：新加的路由自动也有（不靠每条自己写 try）', () => {
  const routes = routesWith()
  assert.ok(routes.length > 30, '路由数量看起来不对')
  // guardedRoute 是 buildRoutes 末尾统一包装时给的具名 handler：
  // 少包一条，那条就会露出原函数名，这里逐条点名。
  const unwrapped = routes.filter((r) => r.handler.name !== 'guardedRoute').map((r) => r.path)
  assert.deepEqual(unwrapped, [], '这些路由没过兜底包装：' + unwrapped.join(', '))
})

test('声明了 status 的错误保留原状态码（比如 403 / 404）', async () => {
  // ★ 2026-11-20 改：原来拿 /world/diary 当试金石，
  //   但它现在自己 catch 了（走 unboundWorld → 200），到不了兜底。
  //   换一条**没有自己 try/catch 的读路由**来验兜底包装本身的行为。
  const err = Object.assign(new Error('只允许本机调用'), { status: 403 })
  const routes = routesWith({ status: () => { throw err } })
  const res = response()
  // world/state 直接 return world.status()，异常会冒到兜底
  await routeFor(routes, '/dsh-fish-world/world/state').handler(request(), res)
  assert.equal(res.statusCode, 403, '业务自己定的状态码不该被改成 500')
  assert.equal(res.json().error, '只允许本机调用')
})

// 「写完响应头之后才失败」是真实场景：图片路由先 writeHead(200) 再 end(bytes)，
// 主人中途关窗口时 end() 自己抛，catch 里又想 reply(404) —— 第二次 writeHead
// 会炸成 ERR_STREAM_WRITE_AFTER_END，比原来的错更难查。reply() 里统一防一次。
test('图片路由：客户端断开（end 抛错）时不该冒成 write-after-end', async () => {
  const routes = buildRoutes({
    loader: { list: () => [] },
    market: {},
    qq: {},
    configStore: {},
    world: { status: () => ({ ok: true }) },
    roles: {
      current: () => ({ id: 'default', name: '鱼' }),
      list: () => [],
      summary: () => ({ current: null, roles: [], count: 0 }),
      // 把本测试文件当图片字节：一定读得出来，end() 才会被下面的替身弄炸
      imageFor: () => ({ path: fileURLToPath(import.meta.url), ext: 'png' }),
    },
  })
  let writeHeads = 0
  const res = {
    headersSent: false,
    statusCode: 0,
    writeHead(code) { writeHeads += 1; this.statusCode = code; this.headersSent = true },
    end() { throw new Error('write ECANCELED') }, // 模拟断开
  }
  await routeFor(routes, '/dsh-fish-world/role-image').handler(
    request({ url: '/dsh-fish-world/role-image?id=default' }),
    res,
  )
  assert.equal(writeHeads, 1, `断开后不该再写第二个响应头，实际 ${writeHeads} 次`)
})
