pub mod commands;

use crate::module::ModuleBackend;

pub struct HttpModule;
impl ModuleBackend for HttpModule {
    fn id(&self) -> &'static str {
        "http"
    }
    fn is_stateless(&self) -> bool {
        true
    }
}
