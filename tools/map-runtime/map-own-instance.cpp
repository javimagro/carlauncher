// Manual MGU21 probe. Does not join an existing map or control route guidance.
// Wire evidence and limitations: MAPA-ENSAYO-LOCAL.md. Never installed by Store.
#include <vsomeip/vsomeip.hpp>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fcntl.h>
#include <mutex>
#include <poll.h>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace {
using Bytes = std::vector<vsomeip::byte_t>;
constexpr uint32_t Owner = 0x424d5701;
volatile sig_atomic_t interrupted = 0;
void signalStop(int) { interrupted = 1; }
void u16(Bytes& b, uint16_t v) { b.push_back(v >> 8); b.push_back(v); }
void u32(Bytes& b, uint32_t v) { u16(b, v >> 16); u16(b, v); }
void u64(Bytes& b, uint64_t v) { u32(b, v >> 32); u32(b, v); }
uint32_t read32(const unsigned char* p) {
    return uint32_t(p[0]) << 24 | uint32_t(p[1]) << 16 | uint32_t(p[2]) << 8 | p[3];
}
bool number(const char* text, int base, uint64_t& value) {
    if (!text || !*text || *text == '-') return false;
    char* end = nullptr;
    errno = 0;
    value = strtoull(text, &end, base);
    return !errno && end && !*end;
}
std::string recordPath(const std::string& directory) {
    const std::string prefix = "/tmp/bmwlauncher-map-trial-";
    struct stat st{};
    if (directory.compare(0, prefix.size(), prefix) || directory.size() <= prefix.size() ||
        directory.find('/', prefix.size()) != std::string::npos ||
        lstat(directory.c_str(), &st) || !S_ISDIR(st.st_mode) || st.st_uid != getuid() ||
        (st.st_mode & 077) != 0) return {};
    return directory + "/owned-map.bin";
}
bool saveRecord(const std::string& file, uint32_t handle, uint32_t surface) {
    Bytes data; u32(data, 0x424d4150); u32(data, Owner); u32(data, handle); u32(data, surface);
    const int fd = open(file.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (fd < 0) return false;
    const bool ok = write(fd, data.data(), data.size()) == static_cast<ssize_t>(data.size()) && fsync(fd) == 0;
    close(fd);
    return ok;
}
uint32_t loadRecord(const std::string& file) {
    const int fd = open(file.c_str(), O_RDONLY | O_NOFOLLOW);
    if (fd < 0) return 0;
    struct stat st{}; unsigned char data[16]{};
    const bool ok = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == getuid() &&
        (st.st_mode & 077) == 0 && st.st_size == sizeof(data) &&
        time(nullptr) >= st.st_mtime && time(nullptr) - st.st_mtime <= 300 &&
        read(fd, data, sizeof(data)) == sizeof(data);
    close(fd);
    if (!ok || read32(data) != 0x424d4150 || read32(data + 4) != Owner) return 0;
    const uint32_t handle = read32(data + 8);
    return handle && handle != 0xffffffffU ? handle : 0;
}

struct Reply { bool received = false; unsigned code = 255; Bytes bytes; };
class Connection {
    std::shared_ptr<vsomeip::runtime> runtime_ = vsomeip::runtime::get();
    std::shared_ptr<vsomeip::application> app_;
    std::thread loop_;
    std::mutex mutex_;
    std::condition_variable condition_;
    bool base_ = false, ext_ = false, waiting_ = false;
    vsomeip::service_t service_ = 0;
    vsomeip::method_t method_ = 0;
    vsomeip::client_t client_ = 0;
    vsomeip::session_t session_ = 0;
    Reply reply_;
public:
    explicit Connection(const char* name) : app_(runtime_->create_application(name)) {}
    bool start(bool requireExt = true) {
        app_->register_availability_handler(0xfa95, 1, [this](vsomeip::service_t, vsomeip::instance_t, bool available) {
            std::lock_guard<std::mutex> lock(mutex_); base_ = available; condition_.notify_all();
        }, 5, 2);
        app_->register_availability_handler(0xfa94, 1, [this](vsomeip::service_t, vsomeip::instance_t, bool available) {
            std::lock_guard<std::mutex> lock(mutex_); ext_ = available; condition_.notify_all();
        }, 30, 11);
        app_->register_message_handler(vsomeip::ANY_SERVICE, 1, vsomeip::ANY_METHOD,
            [this](const std::shared_ptr<vsomeip::message>& message) {
                std::lock_guard<std::mutex> lock(mutex_);
                if (!waiting_ || message->get_service() != service_ || message->get_method() != method_ ||
                    message->get_client() != client_ || message->get_session() != session_ ||
                    (message->get_message_type() != vsomeip::message_type_e::MT_RESPONSE &&
                     message->get_message_type() != vsomeip::message_type_e::MT_ERROR)) return;
                auto payload = message->get_payload();
                if (payload->get_length() > 4096) return;
                reply_.code = unsigned(message->get_return_code());
                if (payload->get_length())
                    reply_.bytes.assign(payload->get_data(), payload->get_data() + payload->get_length());
                reply_.received = true; waiting_ = false; condition_.notify_all();
            });
        if (!app_->init()) return false;
        loop_ = std::thread([this]() { app_->start(); });
        app_->request_service(0xfa95, 1, 5, 2);
        app_->request_service(0xfa94, 1, 30, 11);
        std::unique_lock<std::mutex> lock(mutex_);
        return condition_.wait_for(lock, std::chrono::seconds(8), [this, requireExt]() { return base_ && (!requireExt || ext_); });
    }
    Reply call(uint16_t service, uint16_t method, const Bytes& data, unsigned timeoutMs = 4000) {
        std::unique_lock<std::mutex> lock(mutex_);
        reply_ = Reply{}; service_ = service; method_ = method; waiting_ = true;
        auto request = runtime_->create_request(false);
        request->set_service(service); request->set_instance(1); request->set_method(method);
        request->set_interface_version(service == 0xfa94 ? 30 : 5);
        auto payload = runtime_->create_payload(); payload->set_data(data); request->set_payload(payload);
        // send assigns the client/session IDs. The handler waits on this mutex until both are recorded.
        app_->send(request); client_ = request->get_client(); session_ = request->get_session();
        condition_.wait_for(lock, std::chrono::milliseconds(timeoutMs), [this]() { return reply_.received; });
        waiting_ = false;
        printf("{\"event\":\"rpc\",\"service\":%u,\"method\":%u,\"received\":%s,\"code\":%u,\"bytes\":%zu}\n",
            service, method, reply_.received ? "true" : "false", reply_.code, reply_.bytes.size());
        return reply_;
    }
    ~Connection() {
        if (!loop_.joinable()) return;
        app_->release_service(0xfa94, 1); app_->release_service(0xfa95, 1);
        app_->clear_all_handler(); app_->stop(); loop_.join();
    }
};
bool ok(const Reply& reply, size_t length) { return reply.received && reply.code == 0 && reply.bytes.size() == length; }
Bytes own(uint32_t handle) { Bytes b; u32(b, Owner); u32(b, handle); return b; }
}

int main(int argc, char** argv) {
    setbuf(stdout, nullptr);
    const bool inspect = argc == 2 && !strcmp(argv[1], "--inspect");
    const bool trial = argc == 5 && !strcmp(argv[1], "--trial");
    const bool cleanup = argc == 3 && !strcmp(argv[1], "--cleanup");
    const char* permit = getenv("BMWLAUNCHER_MAP_TRIAL");
    if (!inspect && ((!trial && !cleanup) || !permit || strcmp(permit, "1"))) {
        fputs("Manual only. --inspect; or BMWLAUNCHER_MAP_TRIAL=1 --trial SURFACE SCENE_HEX PRIVATE_DIR; --cleanup PRIVATE_DIR\n", stderr);
        return 2;
    }
    uint64_t surface = 0, scene = 0;
    std::string record;
    if (trial) {
        if (!number(argv[2], 10, surface) || surface < 0x4d410000 || surface > 0x4d41ffff ||
            !number(argv[3], 16, scene) || (scene >> 32) != 0x424d574c || !uint32_t(scene)) return 2;
        record = recordPath(argv[4]);
        if (record.empty() || access(record.c_str(), F_OK) == 0) return 2;
    } else if (cleanup) {
        record = recordPath(argv[2]);
        if (record.empty()) return 2;
        if (access(record.c_str(), F_OK) != 0) return 0;
    }
    signal(SIGTERM, signalStop); signal(SIGINT, signalStop); signal(SIGHUP, signalStop);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(45);
    // Cleanup runs only once the original process has exited, reusing its configured client name.
    Connection connection("BMWLauncherMapProbe");
    if (!connection.start(!cleanup)) { puts("{\"event\":\"service_unavailable\"}"); return 3; }
    if (inspect) {
        const auto visibility = connection.call(0xfa95, 0x32, {});
        const auto themes = connection.call(0xfa95, 0x40, {});
        return visibility.received && themes.received ? 0 : 3;
    }
    uint32_t handle = 0;
    if (trial) {
        Bytes data; u32(data, Owner); u16(data, 1038); u16(data, 468); u16(data, 204); u16(data, 204);
        u32(data, 28); u32(data, 3); // CommonAPI union length/type, not the in-memory Variant ordinal.
        u64(data, 1); u64(data, scene); // RAMSES connection 1; a new, separately reserved scene ID.
        u32(data, 0); u32(data, surface); u32(data, surface); // display 0, surface, matching native IVI layer.
        const auto created = connection.call(0xfa94, 2, data, 8000);
        if (!ok(created, 4)) { puts("{\"event\":\"create_unconfirmed\"}"); return 4; }
        handle = read32(created.bytes.data());
        if (!handle || handle == 0xffffffffU) return 4;
        if (!saveRecord(record, handle, surface)) {
            connection.call(0xfa95, 3, own(handle)); return 5;
        }
        printf("{\"event\":\"created\",\"handle\":%u,\"surface\":%u}\n", handle, unsigned(surface));
        bool shown = false;
        std::string input;
        while (!interrupted && std::chrono::steady_clock::now() < deadline) {
            pollfd poller{STDIN_FILENO, POLLIN, 0};
            if (poll(&poller, 1, 100) < 0) continue;
            if (poller.revents & (POLLHUP | POLLERR | POLLNVAL)) break;
            if (!(poller.revents & POLLIN)) continue;
            char buffer[64]; const ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
            if (count <= 0) break;
            input.append(buffer, static_cast<size_t>(count));
            if (input.size() > 128) break;
            size_t newline;
            while ((newline = input.find('\n')) != std::string::npos) {
                const std::string command = input.substr(0, newline); input.erase(0, newline + 1);
                if (command == "SHOW" && !shown) {
                    shown = true;
                    Bytes theme = own(handle); u32(theme, 1000);
                    Bytes follow = own(handle); follow.push_back(1);
                    if (!ok(connection.call(0xfa95, 0x3e, theme), 0) ||
                        !ok(connection.call(0xfa95, 8, follow), 0)) { interrupted = 1; break; }
                    Bytes visible = own(handle); u32(visible, 0x43);
                    const auto reply = connection.call(0xfa95, 0x30, visible, 5000);
                    printf("{\"event\":\"visibility\",\"acknowledged\":%s}\n", ok(reply, 0) ? "true" : "false");
                    // No retry or additional setter if visibility stays pending. Observe, then release.
                } else if (command == "STOP") interrupted = 1;
                else { interrupted = 1; break; }
            }
        }
    } else handle = loadRecord(record);
    if (!handle) return 5;
    const bool released = ok(connection.call(0xfa95, 3, own(handle)), 0);
    if (released) unlink(record.c_str());
    printf("{\"event\":\"released\",\"acknowledged\":%s}\n", released ? "true" : "false");
    return released ? 0 : 6;
}
