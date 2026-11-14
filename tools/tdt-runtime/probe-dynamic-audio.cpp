// Manual diagnostic probe for the MGU21 DynamicTempMedia player (0xb0c0:2).
// Does not run during BMWLauncher startup and is not installed by
// component.json.
// --inspect is read-only. --play requires an authorised stationary-car trial,
// /tmp/bmwlauncher-audio-probe owned by this UID with mode 0755 and a soft
// audio-probe.wav fixture inside. A separate child releases our own focus on
// timeout. See TDT-AUDIO-MGU21.md. Playback acceptance is not proof of audible
// sound.
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <limits.h>
#include <mutex>
#include <set>
#include <sys/stat.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <vector>
#include <vsomeip/vsomeip.hpp>
using Bytes = std::vector<vsomeip::byte_t>;
static void u32(Bytes &b, unsigned v) {
  b.push_back(v >> 24);
  b.push_back(v >> 16);
  b.push_back(v >> 8);
  b.push_back(v);
}
static bool writeAll(int fd, const void *data, size_t size) {
  const unsigned char *p = static_cast<const unsigned char *>(data);
  while (size) {
    ssize_t n = write(fd, p, size);
    if (n < 0 && errno == EINTR)
      continue;
    if (n <= 0)
      return false;
    p += n;
    size -= size_t(n);
  }
  return true;
}
static unsigned r32(const Bytes &b, unsigned at) {
  return unsigned(b[at]) << 24 | unsigned(b[at + 1]) << 16 |
         unsigned(b[at + 2]) << 8 | b[at + 3];
}
static void str(Bytes &b, const char *p) {
  u32(b, 4 + 2 * strlen(p));
  b.push_back(254);
  b.push_back(255);
  for (; *p; p++) {
    b.push_back(0);
    b.push_back(*p);
  }
  b.push_back(0);
  b.push_back(0);
}
int main(int argc, char **argv) {
  bool cleanup = argc == 2 && strcmp(argv[1], "--release") == 0;
  bool playTrial = argc == 2 && strcmp(argv[1], "--play") == 0;
  bool inspect = argc == 1 || (argc == 2 && strcmp(argv[1], "--inspect") == 0);
  if (!cleanup && !playTrial && !inspect) {
    fputs("Usage: probe-dynamic-audio [--inspect|--play|--release]\n", stderr);
    return 1;
  }
  const char *tokenPath = "/tmp/bmwlauncher-audio-probe/own-focus-token";
  const char *restorePath = "/tmp/bmwlauncher-audio-probe/own-autoplay";
  struct stat directory {};
  if (!inspect &&
      (lstat("/tmp/bmwlauncher-audio-probe", &directory) != 0 ||
       !S_ISDIR(directory.st_mode) || directory.st_uid != geteuid() ||
       (directory.st_mode & 0777) != 0755)) {
    puts("PRIVATE_TRIAL_DIRECTORY_REQUIRED");
    return 3;
  }
  struct stat fixture {};
  if (playTrial &&
      (lstat("/tmp/bmwlauncher-audio-probe/audio-probe.wav", &fixture) != 0 ||
       !S_ISREG(fixture.st_mode) || fixture.st_size < 44 ||
       fixture.st_size > 2 * 1024 * 1024 || (fixture.st_mode & 0004) == 0)) {
    puts("READABLE_SOFT_AUDIO_FIXTURE_REQUIRED");
    return 3;
  }
  if (playTrial && access(tokenPath, F_OK) == 0) {
    puts("EXISTING_OWN_TOKEN_REQUIRES_CLEANUP");
    return 3;
  }
  pid_t watcher = -1;
  if (playTrial) {
    char executable[PATH_MAX];
    ssize_t n = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (n <= 0 || n >= ssize_t(sizeof(executable) - 1))
      return 4;
    executable[n] = 0;
    watcher = fork();
    if (watcher < 0)
      return 4;
    if (watcher == 0) {
      setsid();
      sleep(40);
      execl(executable, executable, "--release", static_cast<char *>(nullptr));
      _exit(127);
    }
  }
  alarm(35);
  setbuf(stdout, nullptr);
  auto r = vsomeip::runtime::get();
  auto a = r->create_application(cleanup ? "BMWLauncherAudioCleanup"
                                         : "BMWLauncherAudioProbe");
  std::atomic<bool> ready{false};
  bool done = false;
  unsigned method = 0;
  vsomeip::session_t expectedSession = 0;
  std::mutex responseMutex;
  std::condition_variable responseReady;
  unsigned code = 255;
  Bytes result;
  a->register_availability_handler(
      0xb0c0, 2,
      [&](vsomeip::service_t, vsomeip::instance_t, bool v) { ready = v; }, 1,
      0);
  a->register_message_handler(
      0xb0c0, 2, vsomeip::ANY_METHOD,
      [&](const std::shared_ptr<vsomeip::message> &m) {
        if (m->get_method() == 0x8012) {
          auto event = m->get_payload();
          if (event->get_length() > 0 && event->get_length() < 4096)
            printf("PLAYBACK_ERROR %u\n", unsigned(event->get_data()[0]));
          return;
        }
        std::lock_guard<std::mutex> lock(responseMutex);
        if (done || m->get_method() != method ||
            m->get_session() != expectedSession)
          return;
        auto p = m->get_payload();
        code = unsigned(m->get_return_code());
        if (p->get_length() < 4096)
          result.assign(p->get_data(), p->get_data() + p->get_length());
        done = true;
        responseReady.notify_one();
      });
  if (!a->init())
    return 2;
  std::thread t([&]() { a->start(); });
  a->request_service(0xb0c0, 2, 1, 0);
  for (int i = 0; i < 500 && !ready; i++)
    usleep(10000);
  auto rpc = [&](unsigned m, const Bytes &data) {
    std::unique_lock<std::mutex> lock(responseMutex);
    method = m;
    done = false;
    result.clear();
    code = 255;
    auto q = r->create_request(true);
    q->set_service(0xb0c0);
    q->set_instance(2);
    q->set_interface_version(1);
    q->set_method(m);
    auto p = r->create_payload();
    p->set_data(data);
    q->set_payload(p);
    a->send(q);
    expectedSession = q->get_session();
    responseReady.wait_for(lock, std::chrono::seconds(2),
                           [&]() { return done; });
    method = 0;
    printf("RPC %u received=%d code=%u bytes=%zu\n", m, int(done), code,
           result.size());
    if (done && result.size() == 1)
      printf("VALUE %u=%u\n", m, result[0]);
    return done && code == 0;
  };

  if (inspect) {
    for (unsigned m : {3u, 4u, 7u, 9u, 18u}) {
      if (rpc(m, {}) && result.size() == 8)
        printf("PAIR %u=%u,%u\n", m, r32(result, 0), r32(result, 4));
    }
    a->release_service(0xb0c0, 2);
    a->clear_all_handler();
    a->stop();
    t.join();
    alarm(0);
    return 0;
  }
  if (cleanup) {
    Bytes token;
    int fd = open(tokenPath, O_RDONLY | O_NOFOLLOW);
    if (fd >= 0) {
      unsigned char b[520];
      int n = read(fd, b, sizeof(b));
      close(fd);
      if (n >= 8)
        token.assign(b, b + n);
    }
    if (!token.empty() && r32(token, 0) + 4 == token.size()) {
      int restore = open(restorePath, O_RDONLY | O_NOFOLLOW);
      unsigned char prior = 0;
      if (restore >= 0) {
        if (read(restore, &prior, 1) == 1 && prior <= 1) {
          Bytes b = token;
          b.push_back(prior);
          rpc(51, b);
        }
        close(restore);
      }
    }
    if (!token.empty() && r32(token, 0) + 4 == token.size() && rpc(24, token) &&
        result.size() == 1) {
      printf("CLEANUP_RESULT %u\n", result[0]);
      if (result[0] == 0 || result[0] == 4) {
        unlink(tokenPath);
        unlink(restorePath);
      }
    }
    a->release_service(0xb0c0, 2);
    a->clear_all_handler();
    a->stop();
    t.join();
    alarm(0);
    return access(tokenPath, F_OK) == 0 ? 5 : 0;
  }
  if (access(tokenPath, F_OK) == 0) {
    puts("EXISTING_OWN_TOKEN_REQUIRES_CLEANUP");
    a->stop();
    t.join();
    return 3;
  }
  unsigned char priorAutoplay = 0;
  bool priorKnown = ready && rpc(3, {}) && result.size() == 1 && result[0] <= 1;
  if (priorKnown)
    priorAutoplay = result[0];
  bool empty = false;
  if (ready && rpc(2, {})) {
    unsigned pos = 0;
    empty = true;
    for (int i = 0; i < 3; i++) {
      if (pos + 4 > result.size()) {
        empty = false;
        break;
      }
      unsigned n = r32(result, pos);
      pos += 4;
      if (n != 4 || pos + n > result.size()) {
        empty = false;
        break;
      }
      pos += n;
    }
    empty = empty && pos + 1 == result.size();
  }
  Bytes token;
  if (priorKnown && empty && rpc(4, {}) && result.size() == 1 &&
      result[0] == 0) {
    Bytes b;
    str(b, "BMWLauncher-TDT-Trial");
    str(b, "BMWLauncher");
    u32(b, 0);
    if (rpc(23, b) && result.size() >= 9 && result[0] == 0) {
      token.assign(result.begin() + 1, result.end());
      if (r32(token, 0) + 4 != token.size() || token.size() > 520)
        token.clear();
    } else if (!result.empty())
      printf("FOCUS_ERROR %u\n", result[0]);
  } else
    puts("NO_IDLE_UNOWNED_PLAYER");
  if (!token.empty()) {
    int fd = open(tokenPath, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd < 0) {
      rpc(24, token);
      a->stop();
      t.join();
      return 4;
    }
    bool written = writeAll(fd, token.data(), token.size());
    close(fd);
    if (!written) {
      rpc(24, token);
      unlink(tokenPath);
      a->stop();
      t.join();
      return 4;
    }
    puts("FOCUS_GRANTED");
    int restore =
        open(restorePath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (restore < 0 || !writeAll(restore, &priorAutoplay, 1)) {
      if (restore >= 0)
        close(restore);
      rpc(24, token);
      a->stop();
      t.join();
      return 4;
    }
    close(restore);
    a->request_event(0xb0c0, 2, 0x8012, {1}, false);
    a->subscribe(0xb0c0, 2, 1, 1);
    Bytes settings = token;
    settings.push_back(1);
    rpc(51, settings);
    Bytes metadata;
    auto textValue = [&](unsigned key, const char *text) {
      metadata.push_back(key);
      Bytes v;
      str(v, text);
      u32(metadata, v.size());
      u32(metadata, 2);
      metadata.insert(metadata.end(), v.begin(), v.end());
    };
    textValue(16, "file:///tmp/bmwlauncher-audio-probe/audio-probe.wav");
    textValue(3, "BMWLauncher audio trial");
    metadata.push_back(1);
    u32(metadata, 4);
    u32(metadata, 1);
    u32(metadata, 1);
    Bytes item;
    u32(item, 1);
    const char *id = "00000001";
    u32(item, 8);
    item.insert(item.end(), id, id + 8);
    u32(item, metadata.size());
    item.insert(item.end(), metadata.begin(), metadata.end());
    Bytes playlist = token;
    u32(playlist, item.size());
    playlist.insert(playlist.end(), item.begin(), item.end());
    if (rpc(32, playlist) && result.size() == 1)
      printf("PLAYLIST_RESULT %u\n", result[0]);
    for (unsigned w = 0; w < 12; w++) {
      if (rpc(4, {}) && result.size() == 1 && result[0] == 3)
        break;
      usleep(250000);
    }
    // Position zero is the native sentinel for "no selected track".
    // CDeviceOAPDynamic indexes its media array with position - 1.
    Bytes select = token;
    u32(select, 1);
    u32(select, 0);
    rpc(37, select);
    Bytes play = token;
    play.push_back(0);
    play.push_back(0);
    rpc(54, play);
    play.back() = 1;
    rpc(54, play);
    for (unsigned tick = 0; tick < 16; tick++) {
      if (tick % 3 == 0) {
        if (tick == 3) {
          Bytes again = token;
          again.push_back(0);
          again.push_back(0);
          rpc(54, again);
          again.back() = 1;
          rpc(54, again);
        }
        if (rpc(4, {}) && result.size() == 1)
          printf("CONNECTION_STATE %u\n", result[0]);
        if (rpc(9, {}) && result.size() == 1)
          printf("PLAYER_STATE %u\n", result[0]);
        if (rpc(7, {}) && result.size() == 8)
          printf("POSITION %u/%u\n", r32(result, 0), r32(result, 4));
        if (rpc(18, {}) && result.size() == 8)
          printf("TIME_MS %u/%u\n", r32(result, 0), r32(result, 4));
      }
      usleep(1000000);
    }
    a->unsubscribe(0xb0c0, 2, 1);
    a->release_event(0xb0c0, 2, 0x8012);
    Bytes restoreRequest = token;
    restoreRequest.push_back(priorAutoplay);
    rpc(51, restoreRequest);
    if (rpc(24, token) && result.size() == 1) {
      printf("RELEASE_RESULT %u\n", result[0]);
      if (result[0] == 0 || result[0] == 4) {
        unlink(tokenPath);
        unlink(restorePath);
      }
    }
  } else
    puts("NO_FOCUS_ACQUIRED");
  if (watcher > 0 && access(tokenPath, F_OK) != 0) {
    kill(watcher, SIGTERM);
    waitpid(watcher, nullptr, 0);
  }
  a->release_service(0xb0c0, 2);
  a->clear_all_handler();
  a->stop();
  t.join();
  alarm(0);
  return 0;
}
