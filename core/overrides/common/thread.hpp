#pragma once

// Replacement for pos2-chip's common/thread.hpp, picked up first through the include path.
//
// Upstream, `thread` is std::jthread. The plotter creates and joins a fresh set of threads
// for every match key, which is cheap natively but very slow in WebAssembly, where each
// pthread_create is proxied to the browser's main thread. Here `thread` keeps the same
// interface but runs its function as a task on a persistent pool. A thread that joins a
// task helps run queued tasks while it waits, so nested parallel sections cannot deadlock.

#include <atomic>
#include <condition_variable>
#include <deque>
#include <exception>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

namespace pos2w {

class TaskPool {
public:
    struct Task {
        std::function<void()> fn;
        std::exception_ptr error;
        bool done = false;
    };

    static TaskPool& instance()
    {
        static TaskPool pool;
        return pool;
    }

    // Sets the total number of threads doing work, including the thread that joins.
    // Only call this while no tasks are running.
    void set_threads(unsigned n)
    {
        stop_workers();
        unsigned const workers = n > 1 ? n - 1 : 0;
        std::lock_guard<std::mutex> lock(m_);
        stop_ = false;
        for (unsigned i = 0; i < workers; ++i) {
            workers_.emplace_back([this]() { worker_loop(); });
        }
        started_ = true;
    }

    unsigned threads()
    {
        ensure_started();
        return static_cast<unsigned>(workers_.size()) + 1;
    }

    void submit(std::shared_ptr<Task> task)
    {
        ensure_started();
        {
            std::lock_guard<std::mutex> lock(m_);
            queue_.push_back(std::move(task));
        }
        cv_.notify_one();
    }

    // Waits for task to finish, running other queued tasks in the meantime.
    void wait(Task& task)
    {
        std::unique_lock<std::mutex> lock(m_);
        while (!task.done) {
            if (!queue_.empty()) {
                run_front(lock);
                continue;
            }
            cv_.wait(lock, [&]() { return task.done || !queue_.empty(); });
        }
    }

    ~TaskPool() { stop_workers(); }

private:
    TaskPool() = default;

    void ensure_started()
    {
        if (!started_) {
            unsigned hw = std::thread::hardware_concurrency();
            set_threads(hw == 0 ? 1 : hw);
        }
    }

    // Pops and runs the front task. Expects lock to be held and the queue to be non-empty.
    void run_front(std::unique_lock<std::mutex>& lock)
    {
        std::shared_ptr<Task> t = std::move(queue_.front());
        queue_.pop_front();
        lock.unlock();
        // Capture exceptions so the joining thread sees them instead of the worker dying.
        try {
            t->fn();
        }
        catch (...) {
            t->error = std::current_exception();
        }
        t->fn = nullptr;
        lock.lock();
        t->done = true;
        cv_.notify_all();
    }

    void worker_loop()
    {
        std::unique_lock<std::mutex> lock(m_);
        for (;;) {
            cv_.wait(lock, [&]() { return stop_ || !queue_.empty(); });
            if (stop_ && queue_.empty())
                return;
            run_front(lock);
        }
    }

    void stop_workers()
    {
        {
            std::lock_guard<std::mutex> lock(m_);
            stop_ = true;
        }
        cv_.notify_all();
        for (auto& w: workers_) {
            w.join();
        }
        workers_.clear();
    }

    std::mutex m_;
    std::condition_variable cv_;
    std::deque<std::shared_ptr<Task>> queue_;
    std::vector<std::thread> workers_;
    bool stop_ = false;
    bool started_ = false;
};

} // namespace pos2w

// Drop-in for the subset of std::jthread that pos2-chip uses.
class thread {
public:
    template <typename F, typename... Args>
    explicit thread(F&& f, Args&&... args)
        : task_(std::make_shared<pos2w::TaskPool::Task>())
    {
        task_->fn = [f = std::forward<F>(f), ... a = std::forward<Args>(args)]() mutable {
            std::invoke(f, a...);
        };
        pos2w::TaskPool::instance().submit(task_);
    }

    thread(thread const&) = delete;
    thread& operator=(thread const&) = delete;
    thread(thread&&) noexcept = default;
    thread& operator=(thread&& other) noexcept
    {
        if (joinable())
            join();
        task_ = std::move(other.task_);
        return *this;
    }

    ~thread()
    {
        if (joinable())
            join();
    }

    bool joinable() const noexcept { return task_ != nullptr; }

    void join()
    {
        pos2w::TaskPool::instance().wait(*task_);
        std::exception_ptr error = task_->error;
        task_.reset();
        if (error)
            std::rethrow_exception(error);
    }

private:
    std::shared_ptr<pos2w::TaskPool::Task> task_;
};
