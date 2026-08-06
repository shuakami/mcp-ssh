import sys
import os
import shutil
import subprocess
import signal

CREATE_NO_WINDOW = 0x08000000

proc = None


def handle_termination(signum, frame):
    terminate_child()
    sys.exit(0)


def terminate_child():
    """结束 node 子进程。

    早先这里用 shell=True 启动，Windows 上会多插一层 cmd.exe：
    proc 指向 cmd，terminate() 只杀得到 cmd，node 原地变孤儿
    （实测机器上堆积了 7 个，最老的挂了 4 天、涨到 766MB）。
    现在直接 exec node，proc 就是 node 本身，这里能真正杀掉它。
    """
    if not proc or proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
            proc.wait(timeout=2)
        except Exception:
            pass


def main():
    global proc

    signal.signal(signal.SIGINT, handle_termination)
    signal.signal(signal.SIGTERM, handle_termination)

    try:
        current_dir = os.path.dirname(os.path.abspath(__file__))
        index_js_path = os.path.join(current_dir, 'dist', 'index.js')

        if not os.path.exists(index_js_path):
            sys.stderr.write(
                "Error: %s 不存在，请先运行 npm run build\n" % index_js_path
            )
            sys.exit(1)

        # 显式解析 node，避免依赖 shell 的 PATH 查找
        node = shutil.which('node')
        if not node:
            sys.stderr.write("Error: 找不到 node，请确认它在 PATH 中\n")
            sys.exit(1)

        # 不用 shell=True：参数以列表传入，proc 直接就是 node 进程。
        # 这样既拿得到真实 pid，也不会因路径含空格而被 shell 拆词。
        proc = subprocess.Popen(
            [node, index_js_path],
            stdin=sys.stdin,
            stdout=sys.stdout,
            stderr=sys.stderr,
            env=os.environ,
            **({"creationflags": CREATE_NO_WINDOW} if os.name == "nt" else {})
        )

        proc.wait()

    except Exception as e:
        sys.stderr.write("Error: %s\n" % str(e))
    finally:
        # 无论正常结束还是异常退出，都不留下 node 子进程
        terminate_child()

    sys.exit(proc.returncode if proc and proc.returncode is not None else 1)


if __name__ == "__main__":
    main()
