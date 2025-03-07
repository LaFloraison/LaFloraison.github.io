window.onscroll = function () {
    var windowHeight = window.innerHeight; // 获取窗口的高度
    var scrollHeight = document.documentElement.scrollHeight; // 获取文档的总高度
    var scrollTop = document.documentElement.scrollTop || document.body.scrollTop; // 获取滚动的距离
    if (windowHeight + scrollTop >= scrollHeight) {
        // 页面滚动到底部时执行的代码，例如显示评论区
        document.getElementById('gitalk-container').style.display = 'block';
    }
};