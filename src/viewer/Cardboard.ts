import * as THREE from 'three'

type PermissionEvent = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied' | string>
}

/**
 * Device-orientation controller for the IMANTAU mobile VR view.
 *
 * The renderer intentionally uses one full-screen view (not split stereo),
 * matching the current project's Cardboard presentation.
 */
export class Cardboard {
  active = false

  private raw = new THREE.Quaternion()
  private correction = new THREE.Quaternion()
  private euler = new THREE.Euler()
  private screenRotation = new THREE.Quaternion()
  private readonly base = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2)
  private readonly axis = new THREE.Vector3(0, 0, 1)
  private latest = 0
  private forwardTarget = new THREE.Vector3(30, 6, 52)
  private sessionId = 0
  private listening = false

  private savedPosition = new THREE.Vector3()
  private savedQuaternion = new THREE.Quaternion()
  private savedFov = 42

  private pending: ((value: boolean) => void) | null = null

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  private onOrientation = (event: DeviceOrientationEvent) => {
    if (event.alpha === null || event.beta === null || event.gamma === null) return

    const rad = THREE.MathUtils.degToRad
    this.euler.set(rad(event.beta), rad(event.alpha), -rad(event.gamma), 'YXZ')

    const screen = window.screen as Screen & { orientation?: ScreenOrientation }
    const legacyOrientation = (window as Window & { orientation?: number }).orientation
    const angle = screen.orientation?.angle ?? Number(legacyOrientation ?? 0)

    this.raw
      .setFromEuler(this.euler)
      .multiply(this.base)
      .multiply(this.screenRotation.setFromAxisAngle(this.axis, -rad(angle)))

    this.latest = performance.now()

    const resolve = this.pending
    if (resolve) {
      this.pending = null
      resolve(true)
    }
  }

  /**
   * Must be called directly from a user gesture so iOS can show its
   * DeviceOrientation permission prompt.
   */
  async start(spawnPosition: THREE.Vector3, lookTarget: THREE.Vector3): Promise<boolean> {
    this.stop()
    const session = ++this.sessionId

    if (!window.isSecureContext || typeof DeviceOrientationEvent === 'undefined') {
      return false
    }

    try {
      const api = DeviceOrientationEvent as PermissionEvent
      if (typeof api.requestPermission === 'function') {
        const permission = await api.requestPermission()
        if (permission !== 'granted' || session !== this.sessionId) return false
      }

      if (session !== this.sessionId) return false

      this.latest = 0
      this.listening = true
      window.addEventListener('deviceorientation', this.onOrientation, { passive: true })

      const sampled = await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => {
          if (session !== this.sessionId) {
            resolve(false)
            return
          }
          this.pending = null
          resolve(false)
        }, 5000)

        this.pending = (value) => {
          window.clearTimeout(timer)
          resolve(value)
        }
      })

      if (!sampled || session !== this.sessionId) {
        if (session === this.sessionId) this.stop()
        return false
      }

      this.savedPosition.copy(this.camera.position)
      this.savedQuaternion.copy(this.camera.quaternion)
      this.savedFov = this.camera.fov

      this.camera.position.copy(spawnPosition)
      this.forwardTarget.copy(lookTarget)
      this.camera.lookAt(this.forwardTarget)
      this.camera.fov = 80
      this.camera.updateProjectionMatrix()

      this.recenter()
      this.active = true
      return true
    } catch (error) {
      if (session === this.sessionId) this.stop()
      console.warn('Cardboard could not start:', error)
      return false
    }
  }

  /** Align the current sensor heading with the scene's forward direction. */
  recenter() {
    if (!this.listening || this.latest === 0) return

    const direction = this.forwardTarget.clone().sub(this.camera.position)
    direction.y = 0

    if (direction.lengthSq() < 1e-8) return

    const level = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(
        new THREE.Vector3(),
        direction.normalize(),
        new THREE.Vector3(0, 1, 0),
      ),
    )

    this.correction.copy(level).multiply(this.raw.clone().invert())
  }

  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    width: number,
    height: number,
  ) {
    if (!this.active || width <= 0 || height <= 0) return

    this.camera.quaternion.copy(this.correction).multiply(this.raw)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld(true)

    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, width, height)
    renderer.render(scene, this.camera)
  }

  get stale() {
    return this.active && (this.latest === 0 || performance.now() - this.latest > 6000)
  }

  stop() {
    // Invalidate any permission prompt or sensor-sampling promise still pending.
    this.sessionId += 1

    if (this.listening) {
      window.removeEventListener('deviceorientation', this.onOrientation)
      this.listening = false
    }

    const resolve = this.pending
    this.pending = null
    resolve?.(false)

    if (this.active) {
      this.camera.position.copy(this.savedPosition)
      this.camera.quaternion.copy(this.savedQuaternion)
      this.camera.fov = this.savedFov
      this.camera.updateProjectionMatrix()
      this.camera.updateMatrixWorld(true)
    }

    this.active = false
    this.latest = 0
  }
}
